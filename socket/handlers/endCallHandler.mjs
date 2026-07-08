// socket/handlers/endCallHandler.mjs

import { logger } from '../../config/logger.mjs';
import { endSession } from '../../services/billingService.mjs';
import { sendSessionReceipt } from '../../services/receiptService.mjs';
import { setInterpreterAvailability, setInterpreterStatus } from '../../db/interpreterRepo.mjs';
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
      // FIX: previously only set is_available=false here — correct for
      // matching safety (getAvailableInterpreters() already filters on
      // is_available, so a disconnected interpreter was never routed new
      // requests), but the separate 'status' column (what Dashboard.jsx /
      // Availability.jsx actually display) was left untouched. An
      // interpreter whose browser crashed or lost network would reopen
      // their dashboard later and still see "Online", with no indication
      // they'd actually been disconnected and unavailable the whole time.
      await setInterpreterAvailability(socket.userId, false).catch(() => {});
      await setInterpreterStatus(socket.userId, 'offline').catch((err) =>
        logger.warn({ err, userId: socket.userId }, 'setInterpreterStatus(offline) failed on disconnect')
      );
      if (socket.userId) {
        io.to(`user:${socket.userId}`).emit('status-update', { status: 'offline' });
      }
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
 * Closes the session, fires receipts to client and admin, then notifies
 * both parties via socket. Receipt failure never blocks call-end.
 */
async function _endRoom(io, socket, roomId, reason) {
  const room = getRoom(roomId);
  if (!room) return;

  deleteRoom(roomId);

  // Notify both parties
  io.to(roomId).emit('call-ended', { reason });

  // Close session record — per-minute billing already processed by ticks
  if (room.sessionId) {
    await endSession(room.sessionId).catch((err) =>
      logger.error({ err, roomId, sessionId: room.sessionId }, 'endSession failed')
    );

    // Send receipt to client (email or SMS fallback) and admin copy
    // Fire-and-forget — receipt failure must never block the call-end flow
    sendSessionReceipt(room.sessionId).catch((err) =>
      logger.error({ err, sessionId: room.sessionId }, 'sendSessionReceipt unexpected error')
    );
  }

  await audit(socket.userId, AUDIT_ACTIONS.CALL_ENDED, {
    roomId,
    sessionId: room.sessionId,
    reason,
  });

  logger.info({ roomId, sessionId: room.sessionId, reason }, 'Room ended');
}
