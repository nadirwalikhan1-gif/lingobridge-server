import { validateEvent } from '../../middleware/validateEvent.mjs';
import { rateLimitSocket } from '../../middleware/rateLimiter.mjs';
import { getRoom, updateRoom, deleteRoom, claimRoom, releaseClaim } from '../runtime/sessionRuntime.mjs';
import { claimSessionForInterpreter, unclaimSession, updateSessionStatus } from '../../db/sessionRepo.mjs';
import { releaseReservation } from '../../db/walletRepo.mjs';
import { supabaseAdmin } from '../../config/supabase.mjs';
import { generateAgoraToken } from '../../services/agoraService.mjs';
import { eventBus, EVENTS } from '../../utils/eventBus.mjs';
import { logger } from '../../config/logger.mjs';

export function acceptHandler(io, socket) {
  socket.on('accept-call', async (data) => {
    if (!rateLimitSocket(socket, 'accept-call', { max: 5, windowMs: 10_000 })) return;

    const { valid, errors, sanitized } = validateEvent('accept-call', data);
    if (!valid) {
      socket.emit('error', { code: 'VALIDATION_ERROR', errors });
      return;
    }

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

    // Cheap early exit for the common case — not the actual atomicity
    // guarantee (see claimRoom() below, which does the real check-and-set).
    if (room.interpreterSocketId) {
      socket.emit('error', { code: 'ROOM_TAKEN', message: 'Room already accepted by another interpreter' });
      return;
    }

    // FIX: preference window — while active, this request was only actually
    // sent to the client's selected interpreter (see requestHandler.mjs), so
    // this should rarely trigger. Kept as defense-in-depth in case another
    // interpreter learns of the room some other way (e.g. admin tooling)
    // during the window.
    if (
      room.preferredInterpreterId &&
      room.preferredUntil &&
      Date.now() < room.preferredUntil &&
      room.preferredInterpreterId !== interpreterId
    ) {
      socket.emit('error', {
        code: 'PREFERRED_INTERPRETER_WINDOW',
        message: 'This request is currently reserved for another interpreter.',
      });
      return;
    }

    // FIX: double-booking race. Previously getRoom() (a read) was checked
    // here, but the actual claim (updateRoom(...) setting interpreterSocketId)
    // only happened after a whole chain of awaits below (wallet upsert,
    // activateSession) — leaving a real window where two concurrent
    // accept-call events could both read "not yet taken" and both proceed.
    // claimRoom() below does the check-and-set as one synchronous operation
    // immediately, before any async work starts, so nothing can interleave.
    if (!claimRoom(roomId, socket.id, interpreterId)) {
      socket.emit('error', { code: 'ROOM_TAKEN', message: 'Room already accepted by another interpreter' });
      return;
    }

    try {
      // Authoritative guard — claimRoom() above only protects against races
      // within this same server process (see sessionRuntime.mjs's
      // multi-instance note). This DB-level compare-and-swap via
      // .is('interpreter_id', null) is what actually guarantees correctness,
      // including across multiple instances if this is ever scaled out.
      const claimed = await claimSessionForInterpreter(room.sessionId, interpreterId);
      if (!claimed) {
        // Someone else won it first (a different instance, or a request
        // that reached the DB before this one) — release our in-memory
        // claim so the room doesn't stay falsely "taken" on this process.
        releaseClaim(roomId, socket.id);
        socket.emit('error', { code: 'ROOM_TAKEN', message: 'Room already accepted by another interpreter' });
        return;
      }

      // FIX: everything from here through the client's call-accepted emit
      // runs after the session is already claimed. Previously, a failure
      // anywhere in this section (e.g. the wallet upsert below) fell
      // through to the outer catch, which logs and tells the interpreter
      // "failed" — but never reverted the claim. Since
      // claimSessionForInterpreter's guard is interpreter_id IS NULL, that
      // left the session permanently unacceptable by anyone, ever, while
      // the client never received call-accepted at all. This inner
      // try/catch rolls the claim back on any failure here, so the room
      // becomes available again instead of silently dying.
      try {
        // Ensure interpreter has an earnings vault — upsert avoids race condition
        // when two concurrent accept events fire for the same interpreter.
        await supabaseAdmin
          .from('wallets')
          .upsert(
            { user_id: interpreterId, vault_type: 'interpreter', balance: 0, currency: 'USD', reserved_balance: 0 },
            { onConflict: 'user_id,vault_type', ignoreDuplicates: true }
          );

        socket.join(roomId);

        const channelName = room.channelName ?? roomId;
        const sessionType = room.requestData?.sessionType;
        if (!sessionType) {
          logger.warn({ roomId }, 'sessionType missing from requestData — defaulting to audio');
        }
        const resolvedSessionType = sessionType ?? 'audio';

        let clientToken = null;
        let interpreterToken = null;
        try {
          const [clientResult, interpreterResult] = await Promise.all([
            generateAgoraToken(channelName),
            generateAgoraToken(channelName),
          ]);
          clientToken = clientResult.token;
          interpreterToken = interpreterResult.token;
        } catch (e) {
          logger.warn({ e }, 'Agora token generation failed on accept — parties will retry');
        }

        // FIX: resolve clientName from room data (was undefined variable)
        const clientName = room.requestData?.clientName 
          || room.clientUserId?.split('@')[0] 
          || 'Client';

        io.to(room.clientSocketId).emit('call-accepted', {
          roomId,
          interpreterId,
          sessionId:   room.sessionId,
          channelName,
          agoraToken:  clientToken,
          sessionType: resolvedSessionType,
        });

        socket.emit('call-accepted', {
          roomId,
          clientId:    room.clientUserId,
          sessionId:   room.sessionId,
          channelName,
          agoraToken:  interpreterToken,
          sessionType: resolvedSessionType,
          clientName,  // FIX: was `clientName,clientName` — duplicate undefined
        });

        socket.to('interpreters').emit('request-cancelled', { roomId });

        io.to('admins').emit('call-accepted', {
          roomId,
          interpreterId,
          clientId:    room.clientUserId,
          sessionId:   room.sessionId,
          channelName,
          sessionType: resolvedSessionType,
        });

        logger.info({ roomId, interpreterId, clientId: room.clientUserId, sessionType: resolvedSessionType }, 'Call accepted');
      } catch (postClaimErr) {
        logger.error({ err: postClaimErr, roomId, interpreterId }, 'accept-call failed after claim — rolling back');
        await unclaimSession(room.sessionId, interpreterId).catch((rollbackErr) =>
          logger.error({ err: rollbackErr, roomId, interpreterId }, 'Rollback of session claim also failed — may need manual DB fix')
        );
        releaseClaim(roomId, socket.id);
        socket.emit('error', { code: 'SERVER_ERROR', message: 'Failed to accept call — please try again' });
      }
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

    if (socket.userId !== room.clientUserId) {
      socket.emit('error', { code: 'FORBIDDEN', message: 'Cannot reject this call' });
      return;
    }

    try {
      await releaseReservation(room.clientUserId, room.reservedAmount, 'client');
      eventBus.emit(EVENTS.WALLET_CREDITED, { userId: room.clientUserId });
      await updateSessionStatus(room.sessionId, 'cancelled', { ended_at: new Date().toISOString() });

      io.to('interpreters').emit('request-cancelled', { roomId });
      io.to('admins').emit('request-cancelled', { roomId });

      deleteRoom(roomId);

      logger.info({ roomId, userId: socket.userId }, 'Call rejected/cancelled by client');
    } catch (err) {
      logger.error({ err, roomId }, 'reject-call failed');
    }
  });

  // ── INTERPRETER DECLINES AN INCOMING REQUEST ──────────────────────────────
  // Fire-and-forget from the client: no response event expected, the
  // interpreter's own UI optimistically removes the card immediately.
  // The room stays live so other online interpreters can still accept it —
  // we only record that this interpreter passed on it.
  socket.on('decline-call', async (data) => {
    const { roomId } = data || {};
    if (!roomId) return;

    const interpreterId = socket.userId;
    if (!interpreterId) return;

    const room = getRoom(roomId);
    if (!room) return; // already accepted/cancelled/expired — nothing to do

    const declinedBy = room.declinedBy ? [...room.declinedBy, interpreterId] : [interpreterId];
    updateRoom(roomId, { declinedBy });

    logger.info({ roomId, interpreterId, declinedCount: declinedBy.length }, 'Interpreter declined call');
  });
}