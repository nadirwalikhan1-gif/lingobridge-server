import { validateEvent } from '../../middleware/validateEvent.mjs';
import { rateLimitSocket } from '../../middleware/rateLimiter.mjs';
import { getRoom, updateRoom, deleteRoom } from '../runtime/sessionRuntime.mjs';
import { activateSession, updateSessionStatus } from '../../db/sessionRepo.mjs';
import { releaseReservation } from '../../db/walletRepo.mjs';
import { supabaseAdmin } from '../../config/supabase.mjs';
import { generateAgoraToken } from '../../services/agoraService.mjs';
import { eventBus, EVENTS } from '../../utils/eventBus.mjs';
import { logger } from '../../config/logger.mjs';

export function acceptHandler(io, socket) {
  socket.on('accept-call', async (data) => {
    if (!rateLimitSocket(socket, 'accept-call', { max: 5, windowMs: 10_000 })) return;

    const { valid, errors, sanitized } = validateEvent('accept-call', data);
    if (!valid) {
      socket.emit('error', { code: 'VALIDATION_ERROR', errors });
      return;
    }

    const interpreterId = socket.userId;
    if (!interpreterId) {
      socket.emit('error', { code: 'AUTH_REQUIRED', message: 'Authentication required' });
      return;
    }

    const { roomId } = sanitized;
    const room = getRoom(roomId);

    if (!room) {
      socket.emit('error', { code: 'ROOM_NOT_FOUND', message: 'Room not found or expired' });
      return;
    }

    if (room.interpreterSocketId) {
      socket.emit('error', { code: 'ROOM_TAKEN', message: 'Room already accepted by another interpreter' });
      return;
    }

    try {
      // Ensure interpreter has an earnings vault — upsert avoids race condition
      // when two concurrent accept events fire for the same interpreter.
      await supabaseAdmin
        .from('wallets')
        .upsert(
          { user_id: interpreterId, vault_type: 'interpreter', balance: 0, currency: 'USD', reserved_balance: 0 },
          { onConflict: 'user_id,vault_type', ignoreDuplicates: true }
        );

      await activateSession(room.sessionId, interpreterId);
      updateRoom(roomId, { interpreterSocketId: socket.id, interpreterUserId: interpreterId });
      socket.join(roomId);

      const channelName = room.channelName ?? roomId;
      const sessionType = room.requestData?.sessionType;
      if (!sessionType) {
        logger.warn({ roomId }, 'sessionType missing from requestData — defaulting to audio');
      }
      const resolvedSessionType = sessionType ?? 'audio';

      let clientToken = null;
      let interpreterToken = null;
      try {
        const [clientResult, interpreterResult] = await Promise.all([
          generateAgoraToken(channelName),
          generateAgoraToken(channelName),
        ]);
        clientToken = clientResult.token;
        interpreterToken = interpreterResult.token;
      } catch (e) {
        logger.warn({ e }, 'Agora token generation failed on accept — parties will retry');
      }

      // FIX: resolve clientName from room data (was undefined variable)
      const clientName = room.requestData?.clientName 
        || room.clientUserId?.split('@')[0] 
        || 'Client';

      io.to(room.clientSocketId).emit('call-accepted', {
        roomId,
        interpreterId,
        sessionId:   room.sessionId,
        channelName,
        agoraToken:  clientToken,
        sessionType: resolvedSessionType,
      });

      socket.emit('call-accepted', {
        roomId,
        clientId:    room.clientUserId,
        sessionId:   room.sessionId,
        channelName,
        agoraToken:  interpreterToken,
        sessionType: resolvedSessionType,
        clientName,  // FIX: was `clientName,clientName` — duplicate undefined
      });

      socket.to('interpreters').emit('request-cancelled', { roomId });

      io.to('admins').emit('call-accepted', {
        roomId,
        interpreterId,
        clientId:    room.clientUserId,
        sessionId:   room.sessionId,
        channelName,
        sessionType: resolvedSessionType,
      });

      logger.info({ roomId, interpreterId, clientId: room.clientUserId, sessionType: resolvedSessionType }, 'Call accepted');
    } catch (err) {
      logger.error({ err, roomId, interpreterId }, 'accept-call failed');
      socket.emit('error', { code: 'SERVER_ERROR', message: 'Failed to accept call' });
    }
  });

  socket.on('reject-call', async (data) => {
    const { roomId } = data || {};
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room) return;

    if (socket.userId !== room.clientUserId) {
      socket.emit('error', { code: 'FORBIDDEN', message: 'Cannot reject this call' });
      return;
    }

    try {
      await releaseReservation(room.clientUserId, room.reservedAmount, 'client');
      eventBus.emit(EVENTS.WALLET_CREDITED, { userId: room.clientUserId });
      await updateSessionStatus(room.sessionId, 'cancelled', { ended_at: new Date().toISOString() });

      io.to('interpreters').emit('request-cancelled', { roomId });
      io.to('admins').emit('request-cancelled', { roomId });

      deleteRoom(roomId);

      logger.info({ roomId, userId: socket.userId }, 'Call rejected/cancelled by client');
    } catch (err) {
      logger.error({ err, roomId }, 'reject-call failed');
    }
  });
}