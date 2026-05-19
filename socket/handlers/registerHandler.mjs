import { v4 as uuidv4 } from 'uuid';
import { validateEvent } from '../../middleware/validateEvent.mjs';
import { rateLimitSocket } from '../../middleware/rateLimiter.mjs';
import { addRoom, getRoom } from '../runtime/sessionRuntime.mjs';
import { createSession } from '../../db/sessionRepo.mjs';
import { reserveFunds } from '../../db/walletRepo.mjs';
import { getAvailableBalance } from '../../db/walletRepo.mjs';
import { RESERVATION_AMOUNT } from '../../utils/constants.mjs';
import { eventBus, EVENTS } from '../../utils/eventBus.mjs';
import { logger } from '../../config/logger.mjs';

export function requestHandler(io, socket) {
  socket.on('request-call', async (data) => {
    // Rate limit
    if (!rateLimitSocket(socket, 'request-call', { max: 3, windowMs: 10_000 })) return;

    // Validate payload
    const { valid, errors, sanitized } = validateEvent('request-call', data);
    if (!valid) {
      socket.emit('error', { code: 'VALIDATION_ERROR', errors });
      return;
    }

    // ── AUTH GUARD ── CRITICAL FIX: removed 'demo-client' fallback
    const userId = socket.userId;
    if (!userId) {
      socket.emit('error', { code: 'AUTH_REQUIRED', message: 'Authentication required' });
      return;
    }

    const { language, sessionType } = sanitized;
    const roomId = uuidv4();

    try {
      // Check wallet balance
      const wallet = await getAvailableBalance(userId);
      const reserve = RESERVATION_AMOUNT[wallet.currency]?.[sessionType] ?? 18.00;

      if (wallet.availableBalance < reserve) {
        socket.emit('error', {
          code: 'INSUFFICIENT_FUNDS',
          message: `Need ${reserve} ${wallet.currency} to start a ${sessionType} call.`,
        });
        return;
      }

      // Reserve funds
      await reserveFunds(userId, reserve);
      eventBus.emit(EVENTS.WALLET_CREDITED, { userId, ...await getAvailableBalance(userId) });

      // Create DB session
      const session = await createSession({
        clientId:     userId,
        language,
        purpose:      'general',
        sessionType,
        currency:     wallet.currency,
        agoraChannel: roomId,
      });

      // Add to runtime
      addRoom(roomId, {
        clientSocketId: socket.id,
        clientUserId:   userId,
        sessionId:      session.id,
        reservedAmount: reserve,
        requestData:    { language, sessionType, roomId },
      });

      // Join room
      socket.join(roomId);

      // Emit to client
      socket.emit('call-requested', { roomId, sessionId: session.id });

      // Broadcast to interpreters
      io.emit('new-request', { roomId, language, type: sessionType });

      logger.info({ roomId, userId, language, sessionType }, 'Call requested');
    } catch (err) {
      logger.error({ err, roomId, userId }, 'request-call failed');
      socket.emit('error', { code: 'SERVER_ERROR', message: 'Failed to create call request' });
    }
  });
}