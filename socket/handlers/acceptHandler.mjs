import { validateEvent } from '../../middleware/validateEvent.mjs';
import { rateLimitSocket } from '../../middleware/rateLimiter.mjs';
import { getRoom, updateRoom, deleteRoom } from '../runtime/sessionRuntime.mjs';
import { activateSession, updateSessionStatus } from '../../db/sessionRepo.mjs';
import { releaseReservation } from '../../db/walletRepo.mjs';
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

    // ── AUTH GUARD ── CRITICAL FIX: removed 'demo-client' fallback
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

      // Join room
      socket.join(roomId);

      // Notify client
      io.to(room.clientSocketId).emit('call-accepted', {
        roomId,
        interpreterId,
        sessionId: room.sessionId,
      });

      // Notify interpreter
      socket.emit('call-accepted', {
        roomId,
        clientId: room.clientUserId,
        sessionId: room.sessionId,
      });

      logger.info({ roomId, interpreterId, clientId: room.clientUserId }, 'Call accepted');
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

    // Only client can reject (cancel) their own request
    if (socket.userId !== room.clientUserId) {
      socket.emit('error', { code: 'FORBIDDEN', message: 'Cannot reject this call' });
      return;
    }

    try {
      // Release reservation
      await releaseReservation(room.clientUserId, room.reservedAmount);
      eventBus.emit(EVENTS.WALLET_CREDITED, { userId: room.clientUserId });

      // Update DB
      await updateSessionStatus(room.sessionId, 'cancelled', { ended_at: new Date().toISOString() });

      // Notify interpreters
      io.emit('request-cancelled', { roomId });

      // Clean up runtime
      deleteRoom(roomId);

      logger.info({ roomId, userId: socket.userId }, 'Call rejected by client');
    } catch (err) {
      logger.error({ err, roomId }, 'reject-call failed');
    }
  });
}