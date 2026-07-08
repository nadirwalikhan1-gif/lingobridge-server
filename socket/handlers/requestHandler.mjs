import { v4 as uuidv4 } from 'uuid';
import { validateEvent } from '../../middleware/validateEvent.mjs';
import { rateLimitSocket } from '../../middleware/rateLimiter.mjs';
import { addRoom, getRoom, updateRoom } from '../runtime/sessionRuntime.mjs';
import { createSession } from '../../db/sessionRepo.mjs';
import { reserveFunds, getAvailableBalance } from '../../db/walletRepo.mjs';
import { getInterpreterByUserId } from '../../db/interpreterRepo.mjs';
import { generateAgoraToken } from '../../services/agoraService.mjs';
import { CLIENT_RATES } from '../../utils/constants.mjs'; // FIX: vault-model client rates
import { eventBus, EVENTS } from '../../utils/eventBus.mjs';
import { emitToUser } from '../../utils/socketUtils.mjs';
import { logger } from '../../config/logger.mjs';

// TEMP: set to true to disable wallet check for free call testing
// FIX: was a hardcoded boolean literal in source — a financial-safety
// bypass flag like this is exactly the kind of thing that's easy to flip
// true for a local test and accidentally leave that way in a commit.
// Reading from the environment means it can never be silently true in
// production without an explicit, visible deploy-time config choice, and
// defaults to disabled if the variable is unset entirely.
const FREE_CALL_TESTING = process.env.FREE_CALL_TESTING === 'true';

// FIX: when a client selects a specific interpreter, give that interpreter
// this long to accept before silently opening the request to everyone else.
// Chosen to stay well within the platform's "<1 min" connect promise even
// after falling back.
const PREFERRED_INTERPRETER_WINDOW_MS = 20_000;

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
      interpreterId,
    } = sanitized;

    const roomId = uuidv4();

    // FIX: resolve whether the client's selected interpreter can actually be
    // targeted first. Falls back to null (broadcast-to-all, today's
    // behavior) if no interpreter was selected, the id doesn't correspond to
    // a real interpreter, or they're not currently available — a stale or
    // invalid interpreterId should never block booking.
    let targetInterpreterId = null;
    if (interpreterId) {
      try {
        const candidate = await getInterpreterByUserId(interpreterId);
        if (candidate?.is_available) targetInterpreterId = interpreterId;
      } catch (e) {
        // not a real / not currently available interpreter — fall through to broadcast
      }
    }

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
        toLang,         // FIX: was never passed through — see migrations/20260709_sessions_to_language.sql
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
        // FIX: preference window — while set and unexpired, only this
        // interpreter is allowed to accept (see acceptHandler.mjs). Cleared
        // once the fallback broadcast fires below.
        preferredInterpreterId: targetInterpreterId,
        preferredUntil:         targetInterpreterId ? Date.now() + PREFERRED_INTERPRETER_WINDOW_MS : null,
        requestData: {
          language,
          fromLang:       fromLang ?? language,
          toLang,
          sessionType,
          duration,
          category,
          interpreterName,
          interpreterId:  targetInterpreterId,
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

      io.to('admins').emit('new-request', requestPayload);

      if (targetInterpreterId) {
        // FIX: preference window — send only to the selected interpreter
        // first, instead of broadcasting to everyone immediately. If they
        // don't accept in time, open it up to everyone exactly as before.
        emitToUser(io, targetInterpreterId, 'new-request', requestPayload);

        setTimeout(() => {
          const room = getRoom(roomId);
          // Room may already be gone (accepted, cancelled, or timed out via
          // jobs/requestTimeouts.mjs) — only fall back if it's still pending.
          if (!room || room.interpreterSocketId) return;

          updateRoom(roomId, { preferredInterpreterId: null, preferredUntil: null });
          io.to('interpreters').emit('new-request', requestPayload);
          logger.info({ roomId, targetInterpreterId }, 'Preferred interpreter window expired — broadcasting to all');
        }, PREFERRED_INTERPRETER_WINDOW_MS);
      } else {
        io.to('interpreters').emit('new-request', requestPayload);
      }

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
          targetInterpreterId,
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