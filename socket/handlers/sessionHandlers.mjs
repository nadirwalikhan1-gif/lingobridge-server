// ─── LingoBridge Session Socket Handlers ──────────────────────────────────────
// Handles: hold-session, extend-session, request-payout
//
// Import path: this file lives at ./socket/handlers/
//   ../../db/...       → ./db/
//   ../../utils/...    → ./utils/
//   ../../services/... → ./services/

import {
  getActiveSessionByChannel,
  setSessionOnHold,
  resumeSessionFromHold,
  extendSessionDuration,
} from '../../db/sessionRepo.mjs';

import {
  getAvailableBalance,
  createPayoutRequest,
} from '../../db/walletRepo.mjs';

import { insertTransaction } from '../../db/transactionRepo.mjs';

import {
  CLIENT_RATES,
  MIN_PAYOUT,
} from '../../utils/constants.mjs';

// ─── Handler registration ─────────────────────────────────────────────────────

export function registerSessionHandlers(io, socket) {

  // ── Hold toggle ──────────────────────────────────────────────────────────────
  //
  // Emitted by either participant when they tap the hold button.
  // Payload: { roomId: string, onHold: boolean, initiatorRole: string }
  //
  // Flow:
  //   1. Broadcast to the other participant so their UI updates immediately
  //   2. Write hold state to DB so billing ticks read it correctly
  socket.on('hold-session', async ({ roomId, onHold, initiatorRole }) => {
    if (!roomId) return;

    try {
      // Broadcast to room (excluding sender) so the other side updates
      socket.to(roomId).emit('hold-session', { roomId, onHold, initiatorRole });

      if (onHold) {
        await setSessionOnHold(roomId);
      } else {
        const { totalHoldSeconds } = await resumeSessionFromHold(roomId);
        // Tell both sides the updated total hold time (for UI display)
        io.to(roomId).emit('hold-resumed', { roomId, totalHoldSeconds });
      }
    } catch (err) {
      console.error('[sessionHandlers] hold-session error:', err.message);
      socket.emit('session-error', { event: 'hold-session', message: err.message });
    }
  });

  // ── Extend session ───────────────────────────────────────────────────────────
  //
  // Emitted by the client when they tap "+5 min".
  // Payload: { roomId: string, additionalMinutes?: number }
  //
  // Flow:
  //   1. Fetch session + client balance in one step
  //   2. Check client has enough funds to cover the extension
  //   3. If yes — extend booked_duration, confirm to both sides
  //   4. If no  — deny with reason so the frontend can surface a message
  socket.on('extend-session', async ({ roomId, additionalMinutes = 5 }) => {
    if (!roomId) return;

    try {
      const session = await getActiveSessionByChannel(roomId);
      if (!session) {
        socket.emit('extend-session-denied', { roomId, reason: 'session_not_found' });
        return;
      }

      const addedSeconds   = additionalMinutes * 60;
      const sessionType    = session.session_type || 'audio';
      const currency       = session.currency || 'USD';
      const ratePerMin     = CLIENT_RATES[currency]?.[sessionType]
                          ?? CLIENT_RATES.USD[sessionType];
      const extensionCost  = parseFloat((additionalMinutes * ratePerMin).toFixed(2));

      // Check client vault balance
      const { availableBalance } = await getAvailableBalance(session.client_id, 'client');

      if (availableBalance < extensionCost) {
        socket.emit('extend-session-denied', {
          roomId,
          reason:   'insufficient_balance',
          required: extensionCost,
          balance:  availableBalance,
        });
        return;
      }

      // Extend the session
      const updated = await extendSessionDuration(session.id, addedSeconds);
      const newDurationMinutes = Math.floor(updated.booked_duration / 60);

      // Confirm to both sides
      io.to(roomId).emit('extend-session-confirmed', {
        roomId,
        additionalMinutes,
        newDuration: newDurationMinutes,
      });
    } catch (err) {
      console.error('[sessionHandlers] extend-session error:', err.message);
      socket.emit('extend-session-denied', { roomId, reason: 'server_error' });
    }
  });

  // ── Request payout ───────────────────────────────────────────────────────────
  //
  // Emitted by the interpreter from the Earnings page.
  // Payload: { interpreterId: string, amount: number }
  //
  // Flow:
  //   1. Validate amount >= MIN_PAYOUT
  //   2. Check interpreter vault has sufficient balance
  //   3. Insert payout_requests row (admin approves + pays externally)
  //   4. Respond with success or denial reason
  //
  // NOTE: Balance is NOT deducted here — it is deducted when admin marks
  // the request as 'paid'. This prevents premature deduction if a request
  // is rejected.
  socket.on('request-payout', async ({ interpreterId, amount }) => {
    if (!interpreterId || !amount) return;

    try {
      // Validate minimum threshold
      if (amount < MIN_PAYOUT) {
        socket.emit('payout-response', {
          ok:     false,
          reason: `Minimum payout is $${MIN_PAYOUT.toFixed(2)}`,
        });
        return;
      }

      // Check interpreter vault balance
      const { availableBalance } = await getAvailableBalance(interpreterId, 'interpreter');

      if (availableBalance < amount) {
        socket.emit('payout-response', {
          ok:      false,
          reason:  'Requested amount exceeds available balance',
          balance: availableBalance,
        });
        return;
      }

      // Create payout request (pending admin action)
      const request = await createPayoutRequest(interpreterId, amount);

      socket.emit('payout-response', {
        ok:      true,
        request: {
          id:           request.id,
          amount:       request.amount,
          status:       request.status,
          requestedAt:  request.requested_at,
        },
      });
    } catch (err) {
      console.error('[sessionHandlers] request-payout error:', err.message);
      socket.emit('payout-response', { ok: false, reason: 'server_error' });
    }
  });
}
