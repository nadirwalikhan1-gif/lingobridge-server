import { logger } from '../../config/logger.mjs';
import { setInterpreterAvailability } from '../../db/interpreterRepo.mjs';
import { getPendingRooms } from '../runtime/sessionRuntime.mjs';

/**
 * registerHandler.mjs
 *
 * Handles interpreter online/offline registration via explicit 'register' event.
 * NOTE: Role-based room joining also happens automatically in index.mjs on connect,
 * so interpreters receive broadcasts even without emitting 'register'.
 * This handler exists for:
 *   - DB availability toggling
 *   - Manual go-offline toggle
 *   - Legacy clients that emit 'register' explicitly
 */
export function requestHandler(io, socket) {
  // ── REGISTER (interpreter / client comes online) ──────────────
  socket.on('register', async (data) => {
    const role = data?.role;

    if (role === 'interpreter') {
      // Ensure room membership (idempotent — safe to call multiple times)
      socket.join('interpreters');
      socket.interpreterRole = true;

      // Persist availability in DB (best-effort)
      if (socket.userId) {
        await setInterpreterAvailability(socket.userId, true).catch((err) =>
          logger.warn({ err, userId: socket.userId }, 'setInterpreterAvailability failed')
        );
      }

      // Replay any pending rooms so the dashboard is not empty on load
      const pending = getPendingRooms();
      if (pending.length > 0) {
        socket.emit('pending-requests', pending);
      }

      logger.info(
        { socketId: socket.id, userId: socket.userId, pendingSent: pending.length },
        'Interpreter registered via event'
      );
    }

    if (role === 'client') {
      socket.clientRole = true;
      logger.info({ socketId: socket.id, userId: socket.userId }, 'Client registered');
    }
  });

  // ── GO OFFLINE (interpreter manually toggles off) ────────────
  socket.on('go-offline', async () => {
    if (!socket.interpreterRole) return;

    socket.leave('interpreters');
    socket.interpreterRole = false;

    if (socket.userId) {
      await setInterpreterAvailability(socket.userId, false).catch((err) =>
        logger.warn({ err, userId: socket.userId }, 'setInterpreterAvailability(offline) failed')
      );
    }

    logger.info({ socketId: socket.id, userId: socket.userId }, 'Interpreter went offline');
  });

  // ── GO ONLINE (interpreter manually toggles back on) ─────────
  socket.on('go-online', async () => {
    socket.join('interpreters');
    socket.interpreterRole = true;

    if (socket.userId) {
      await setInterpreterAvailability(socket.userId, true).catch((err) =>
        logger.warn({ err, userId: socket.userId }, 'setInterpreterAvailability(online) failed')
      );
    }

    // Replay pending requests
    const pending = getPendingRooms();
    if (pending.length > 0) {
      socket.emit('pending-requests', pending);
    }

    logger.info({ socketId: socket.id, userId: socket.userId }, 'Interpreter came back online');
  });
}
