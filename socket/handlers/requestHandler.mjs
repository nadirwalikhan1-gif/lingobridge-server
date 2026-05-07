import { logger } from '../../config/logger.mjs';
import { checkMinimumBalance, reserveFunds, releaseReservation } from '../../services/walletService.mjs';
import { createSession } from '../../services/sessionService.mjs';
import { generateChannelName } from '../../services/agoraService.mjs';
import { getUserCurrency } from '../../db/userRepo.mjs';
import { addRoom, getRoom } from '../runtime/sessionRuntime.mjs';
import { rateLimitSocket } from '../../middleware/rateLimiter.mjs';
import { validateEvent } from '../../middleware/validateEvent.mjs';
import { RESERVATION_TIMEOUT_MS } from '../../utils/constants.mjs';
import { audit, AUDIT_ACTIONS } from '../../services/auditService.mjs';

export function requestHandler(io, socket) {
  socket.on('new-request', async (data) => {
    if (!rateLimitSocket(socket, 'new-request')) return;

    const { valid, errors, sanitized } = validateEvent('new-request', data);
    if (!valid) { socket.emit('error', { errors }); return; }

    const { roomId, language, type: sessionType, purpose } = sanitized;
    const { userId } = socket;

    // Prevent duplicate rooms
    if (getRoom(roomId)) {
      logger.warn({ roomId, userId }, 'Duplicate room request');
      return;
    }

    try {
      // Get user currency
      const currency = await getUserCurrency(userId);

      // 1. Pre-call balance check
      await checkMinimumBalance(userId, currency, sessionType);

      // 2. Reserve funds
      const { reservedAmount } = await reserveFunds(userId, currency, sessionType);

      // 3. Create session in DB
      const channelName = generateChannelName(roomId);
      const session = await createSession({
        clientId: userId,
        language,
        purpose,
        sessionType,
        currency,
        agoraChannel: channelName,
      });

      // 4. Store room in runtime
      addRoom(roomId, {
        clientSocketId:      socket.id,
        clientUserId:        userId,
        interpreterSocketId: null,
        sessionId:           session.id,
        reservedAmount,
        currency,
        sessionType,
        requestData:         { ...sanitized, channelName },
      });

      // 5. Broadcast to interpreters
      io.to('interpreters').emit('incoming-request', {
        ...sanitized,
        roomId,
        channelName,
      });

      await audit(userId, AUDIT_ACTIONS.CALL_STARTED, { roomId, language, sessionType });
      logger.info({ roomId, sessionId: session.id, userId }, 'Request broadcast to interpreters');

      // 6. Auto-release if no interpreter accepts within timeout
      setTimeout(async () => {
        const room = getRoom(roomId);
        if (room && !room.interpreterSocketId) {
          logger.info({ roomId }, 'No interpreter — releasing reservation');
          await releaseReservation(userId, reservedAmount).catch(() => {});
          socket.emit('no-interpreters');
        }
      }, RESERVATION_TIMEOUT_MS);

    } catch (err) {
      logger.error({ err, userId, roomId }, 'new-request failed');
      socket.emit('error', {
        code:    err.code || 'REQUEST_FAILED',
        message: err.message,
      });
    }
  });
}
