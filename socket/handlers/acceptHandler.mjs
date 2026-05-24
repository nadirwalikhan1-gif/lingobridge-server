import { validateEvent } from '../../middleware/validateEvent.mjs';
import { rateLimitSocket } from '../../middleware/rateLimiter.mjs';
import { getRoom, updateRoom, deleteRoom } from '../runtime/sessionRuntime.mjs';
import { activateSession, updateSessionStatus } from '../../db/sessionRepo.mjs';
import { releaseReservation } from '../../db/walletRepo.mjs';
import { generateAgoraToken } from '../../services/agoraService.mjs';
import { eventBus, EVENTS } from '../../utils/eventBus.mjs';
import { logger } from '../../config/logger.mjs';

export function acceptHandler(io, socket) {
  socket.on('accept-call', async (data) => {
    // Rate limit
    if (!rateLimitSocket(socket, 'accept-call', { max: 5, windowMs: 10_000 })) return;

    // Validate
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
      // Update DB session
      await activateSession(room.sessionId, interpreterId);

      // Update runtime
      updateRoom(roomId, { interpreterSocketId: socket.id, interpreterUserId: interpreterId });

      // Join socket.io room
      socket.join(roomId);

      const channelName = room.channelName ?? roomId;

      // Generate Agora tokens for both parties
      let clientToken = null;
      let interpreterToken = null;
      try {
       const [clientResult, interpreterResult] = await Promise.all([
  generateAgoraToken(channelName, room.clientUserId),
  generateAgoraToken(channelName, interpreterId),
]);
clientToken = clientResult.token;
interpreterToken = interpreterResult.token;
      } catch (e) {
        logger.warn({ e }, 'Agora token generation failed on accept — parties will retry');
      }

      // Notify client with channelName + token
      io.to(room.clientSocketId).emit('call-accepted', {
        roomId,
        interpreterId,
        sessionId:   room.sessionId,
        channelName,
        agoraToken:  clientToken,
      });

      // Notify accepting interpreter with channelName + token
      socket.emit('call-accepted', {
        roomId,
        clientId:   room.clientUserId,
        sessionId:  room.sessionId,
        channelName,
        agoraToken: interpreterToken,
      });

      // FIX: Notify ALL other interpreters to remove this card from their dashboard
      socket.to('interpreters').emit('request-cancelled', { roomId });

      // FIX: Notify admins that the request was accepted
      io.to('admins').emit('call-accepted', {
        roomId,
        interpreterId,
        clientId:   room.clientUserId,
        sessionId:  room.sessionId,
        channelName,
      });

      logger.info({ roomId, interpreterId, clientId: room.clientUserId }, 'Call accepted');
    } catch (err) {
      logger.error({ err, roomId, interpreterId }, 'accept-call failed');
      socket.emit('error', { code: 'SERVER_ERROR', message: 'Failed to accept call' });
    }
  });

  // ── CLIENT CANCELS REQUEST ────────────────────────────────────
  socket.on('reject-call', async (data) => {
    const { roomId } = data || {};
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room) return;

    // Only the client (caller) can cancel their own request
    if (socket.userId !== room.clientUserId) {
      socket.emit('error', { code: 'FORBIDDEN', message: 'Cannot reject this call' });
      return;
    }

    try {
      await releaseReservation(room.clientUserId, room.reservedAmount);
      eventBus.emit(EVENTS.WALLET_CREDITED, { userId: room.clientUserId });

      await updateSessionStatus(room.sessionId, 'cancelled', { ended_at: new Date().toISOString() });

      // Notify interpreters and admins so they remove the card from their dashboard
      io.to('interpreters').emit('request-cancelled', { roomId });
      io.to('admins').emit('request-cancelled', { roomId });

      deleteRoom(roomId);

      logger.info({ roomId, userId: socket.userId }, 'Call rejected/cancelled by client');
    } catch (err) {
      logger.error({ err, roomId }, 'reject-call failed');
    }
  });
}
