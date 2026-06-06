import { logger } from '../../config/logger.mjs';
import { endSession } from '../../services/billingService.mjs';
import { setInterpreterAvailability } from '../../db/interpreterRepo.mjs';
import { getRoom, deleteRoom, getRoomsForSocket } from '../runtime/sessionRuntime.mjs';
import { rateLimitSocket } from '../../middleware/rateLimiter.mjs';
import { validateEvent } from '../../middleware/validateEvent.mjs';
import { audit, AUDIT_ACTIONS } from '../../services/auditService.mjs';

export function endCallHandler(io, socket) {
  // ── EXPLICIT END CALL ──────────────────────────────────────────────────────
  socket.on('end-call', async (data) => {
    if (!rateLimitSocket(socket, 'end-call')) return;
    const { valid, errors, sanitized } = validateEvent('end-call', data);
    if (!valid) { socket.emit('error', { errors }); return; }
    await _endRoom(io, socket, sanitized.roomId, 'user_ended');
  });

  // ── DISCONNECT ─────────────────────────────────────────────────────────────
  socket.on('disconnect', async (reason) => {
    logger.info({ socketId: socket.id, userId: socket.userId, reason }, 'Socket disconnected');
    if (socket.interpreterRole) {
      await setInterpreterAvailability(socket.userId, false).catch(() => {});
    }
    const roomIds = getRoomsForSocket(socket.id);
    for (const roomId of roomIds) {
      await _endRoom(io, socket, roomId, 'disconnect').catch((err) =>
        logger.error({ err, roomId }, 'Disconnect room cleanup failed')
      );
    }
  });
}

/**
 * Shared end-room logic.
 * stopBilling removed — billing refactor uses global setInterval ticks;
 * there is no per-session billing tracker to stop.
 */
async function _endRoom(io, socket, roomId, reason) {
  const room = getRoom(roomId);
  if (!room) return;

  deleteRoom(roomId);

  // Notify both parties
  io.to(roomId).emit('call-ended', { reason });

  // Close session record in DB — per-minute billing already processed by ticks
  if (room.sessionId) {
    await endSession(room.sessionId).catch((err) =>
      logger.error({ err, roomId, sessionId: room.sessionId }, 'endSession failed')
    );
  }

  await audit(socket.userId, AUDIT_ACTIONS.CALL_ENDED, {
    roomId,
    sessionId: room.sessionId,
    reason,
  });

  logger.info({ roomId, sessionId: room.sessionId, reason }, 'Room ended');
}