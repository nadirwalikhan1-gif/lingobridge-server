import { logger } from '../../config/logger.mjs';
import { setInterpreterAvailability } from '../../db/interpreterRepo.mjs';
import { getPendingRooms } from '../runtime/sessionRuntime.mjs';
import { rateLimitSocket } from '../../middleware/rateLimiter.mjs';
import { validateEvent } from '../../middleware/validateEvent.mjs';

export function registerHandler(io, socket) {
  socket.on('register', async (data) => {
    if (!rateLimitSocket(socket, 'register')) return;

    const { valid, errors, sanitized } = validateEvent('register', data);
    if (!valid) { socket.emit('error', { errors }); return; }

    const { role } = sanitized;
    const { userId } = socket;

    if (role === 'interpreter') {
      socket.join('interpreters');
      socket.interpreterRole = true;

      // Mark available in DB
      await setInterpreterAvailability(userId, true).catch((err) =>
        logger.warn({ err, userId }, 'Failed to set interpreter available')
      );

      logger.info({ userId, socketId: socket.id }, 'Interpreter registered');

      // Send any pending rooms
      const pending = getPendingRooms();
      if (pending.length) socket.emit('pending-requests', pending);

    } else if (role === 'client') {
      socket.join('clients');
      socket.clientRole = true;
      logger.info({ userId, socketId: socket.id }, 'Client registered');
    }
  });
}
