import { v4 as uuidv4 } from 'uuid';
import { validateEvent } from '../../middleware/validateEvent.mjs';
import { rateLimitSocket } from '../../middleware/rateLimiter.mjs';
import { addRoom, getRoom } from '../runtime/sessionRuntime.mjs';
import { createSession } from '../../db/sessionRepo.mjs';
import { reserveFunds, getAvailableBalance } from '../../db/walletRepo.mjs';
import { generateAgoraToken } from '../../services/agoraService.mjs';
import { CLIENT_RATES } from '../../utils/constants.mjs'; // FIX: vault-model client rates
import { eventBus, EVENTS } from '../../utils/eventBus.mjs';
import { logger } from '../../config/logger.mjs';

// TEMP: set to true to disable wallet check for free call testing
const FREE_CALL_TESTING = false;

export function requestHandler(io, socket) {
  socket.on('request-call', async (data) => {
    if (!rateLimitSocket(socket, 'request-call', { max: 3, windowMs: 10_000 })) return;

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

    const {
      language,
      sessionType,
      fromLang,
      toLang,
      duration,
      category,
      interpreterName,
    } = sanitized;

    const roomId = uuidv4();

    try {
      let wallet = { currency: 'USD', availableBalance: 0 };
      let reserve = 0;

      if (!FREE_CALL_TESTING) {
        wallet = await getAvailableBalance(userId, 'client'); // FIX: vault-aware
        // FIX: vault-model — reserve one active minute as buffer
        const ratePerMin = CLIENT_RATES.USD[sessionType] ?? 1.49;
        reserve = ratePerMin;

        if (wallet.availableBalance < reserve) {
          socket.emit('error', {
            code: 'INSUFFICIENT_FUNDS',
            message: `Need $${reserve.toFixed(2)} to start a ${sessionType} call.`,
          });
          return;
        }

        await reserveFunds(userId, reserve, 'client'); // FIX: vault-aware
        eventBus.emit(EVENTS.WALLET_CREDITED, { userId, ...await getAvailableBalance(userId, 'client') });
      } else {
        try {
          wallet = await getAvailableBalance(userId, 'client');
        } catch (e) {
          // ignore — wallet may not exist in test
        }
        logger.info({ userId }, 'FREE_CALL_TESTING: skipping wallet check');
      }

      // FIX: vault-model — pass bookedDuration to session creation
      const bookedDuration = parseInt(duration) * 60 || 1800;

      const session = await createSession({
        clientId:       userId,
        language:       fromLang ?? language,
        purpose:        category ?? 'general',
        sessionType,
        currency:       wallet.currency ?? 'USD',
        agoraChannel:   roomId,
        bookedDuration, // FIX: vault-model
        duration,       // FIX: pass raw duration string too
      });

      let agoraToken = null;
      try {
        const result = generateAgoraToken(roomId);
        agoraToken = result.token;
      } catch (e) {
        logger.warn({ e }, 'Agora token generation failed — client will retry');
      }

      addRoom(roomId, {
        clientSocketId: socket.id,
        clientUserId:   userId,
        sessionId:      session.id,
        reservedAmount: reserve,
        channelName:    roomId,
        createdAt:      Date.now(), // used by jobs/requestTimeouts.mjs
        requestData: {
          language,
          fromLang:       fromLang ?? language,
          toLang,
          sessionType,
          duration,
          category,
          interpreterName,
          roomId,
          channelName:    roomId,
        },
      });

      socket.join(roomId);

      socket.emit('call-requested', {
        roomId,
        sessionId:   session.id,
        channelName: roomId,
        agoraToken,
        sessionType,
      });

      const requestPayload = {
        roomId,
        channelName:    roomId,
        language,
        fromLang:       fromLang ?? language,
        toLang,
        sessionType,
        duration,
        category,
        interpreterName,
        clientName: socket.userEmail?.split('@')[0] ?? 'Client',
      };

      io.to('interpreters').emit('new-request', requestPayload);
      io.to('admins').emit('new-request', requestPayload);

      const interpreterSockets = await io.in('interpreters').fetchSockets();
      logger.info(
        {
          roomId,
          userId,
          language,
          fromLang,
          toLang,
          sessionType,
          duration,
          category,
          interpreterName,
          interpretersOnline: interpreterSockets.length,
        },
        'Call requested — broadcast sent'
      );
    } catch (err) {
      logger.error({ err, roomId, userId }, 'request-call failed');
      socket.emit('error', { code: 'SERVER_ERROR', message: 'Failed to create call request' });
    }
  });
}