import { v4 as uuidv4 } from 'uuid';
import { validateEvent } from '../../middleware/validateEvent.mjs';
import { rateLimitSocket } from '../../middleware/rateLimiter.mjs';
import { addRoom, getRoom } from '../runtime/sessionRuntime.mjs';
import { createSession } from '../../db/sessionRepo.mjs';
import { reserveFunds, getAvailableBalance } from '../../db/walletRepo.mjs';
import { generateAgoraToken } from '../../services/agoraService.mjs';
import { RESERVATION_AMOUNT } from '../../utils/constants.mjs';
import { eventBus, EVENTS } from '../../utils/eventBus.mjs';
import { logger } from '../../config/logger.mjs';

// TEMP: set to true to disable wallet check for free call testing
const FREE_CALL_TESTING = true;

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

    const userId = socket.userId;
    if (!userId) {
      socket.emit('error', { code: 'AUTH_REQUIRED', message: 'Authentication required' });
      return;
    }

    const { language, sessionType } = sanitized;
    const roomId = uuidv4();

    try {
      let wallet = { currency: 'USD', availableBalance: 0 };
      let reserve = 0;

      if (!FREE_CALL_TESTING) {
        // Check wallet balance
        wallet = await getAvailableBalance(userId);
        reserve = RESERVATION_AMOUNT[wallet.currency]?.[sessionType] ?? 18.00;

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
      } else {
        // Free call testing — get currency info only (no balance check)
        try {
          wallet = await getAvailableBalance(userId);
        } catch (e) {
          // ignore — wallet may not exist in test
        }
        logger.info({ userId }, 'FREE_CALL_TESTING: skipping wallet check');
      }

      // Create DB session — use roomId as the Agora channel name
      const session = await createSession({
        clientId:     userId,
        language,
        purpose:      'general',
        sessionType,
        currency:     wallet.currency ?? 'USD',
        agoraChannel: roomId,
      });

      // Generate Agora token for the client
      let agoraToken = null;
      try {
        agoraToken = await generateAgoraToken(roomId, userId);
      } catch (e) {
        logger.warn({ e }, 'Agora token generation failed — client will retry');
      }

      // Add to runtime
      addRoom(roomId, {
        clientSocketId: socket.id,
        clientUserId:   userId,
        sessionId:      session.id,
        reservedAmount: reserve,
        channelName:    roomId,
        requestData:    { language, sessionType, roomId, channelName: roomId },
      });

      // Join the socket.io room
      socket.join(roomId);

      // Tell the client: roomId, sessionId, channelName, token
      socket.emit('call-requested', {
        roomId,
        sessionId:   session.id,
        channelName: roomId,
        agoraToken,
      });

      // Broadcast to interpreters and admins
      const requestPayload = {
        roomId,
        channelName: roomId,
        language,
        type: sessionType,
      };
      io.to('interpreters').emit('new-request', requestPayload);
      io.to('admins').emit('new-request', requestPayload);

      // DEBUG: log how many interpreters received the event
      const interpreterSockets = await io.in('interpreters').fetchSockets();
      logger.info(
        { roomId, userId, language, sessionType, interpretersOnline: interpreterSockets.length },
        'Call requested — broadcast sent'
      );
    } catch (err) {
      logger.error({ err, roomId, userId }, 'request-call failed');
      socket.emit('error', { code: 'SERVER_ERROR', message: 'Failed to create call request' });
    }
  });
}
