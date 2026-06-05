import db from '../../db/index.mjs';
import {
  CLIENT_RATES,
  MIN_PAYOUT,
} from '../../utils/constants.mjs';
import { logger } from '../../config/logger.mjs';

export function registerSessionHandlers(io, socket) {

  // ── Hold toggle ─────────────────────────────────────────────────────────────
  socket.on('hold-session', async ({ roomId, onHold, initiatorRole }) => {
    socket.to(roomId).emit('hold-session', { roomId, onHold, initiatorRole });

    if (onHold) {
      await db.query(
        `UPDATE sessions SET on_hold = true, hold_started_at = NOW()
         WHERE agora_channel = $1 AND status = 'active'`,
        [roomId]
      );
    } else {
      await db.query(
        `UPDATE sessions
         SET on_hold          = false,
             total_hold_seconds = COALESCE(total_hold_seconds, 0)
               + GREATEST(0, EXTRACT(EPOCH FROM (NOW() - hold_started_at))::int),
             hold_started_at  = NULL
         WHERE agora_channel = $1`,
        [roomId]
      );
    }
  });

  // ── Extend session ───────────────────────────────────────────────────────────
  socket.on('extend-session', async ({ roomId, additionalMinutes = 5 }) => {
    const addedSeconds = additionalMinutes * 60;

    const { rows } = await db.query(
      `SELECT s.id, s.client_id, s.interpreter_id, s.session_type,
              w.balance AS client_balance
       FROM sessions s
       JOIN wallets w ON w.user_id = s.client_id AND w.vault_type = 'client'
       WHERE s.agora_channel = $1 AND s.status = 'active'`,
      [roomId]
    );

    if (!rows.length) return;
    const session = rows[0];

    const extensionCost = parseFloat(
      ((addedSeconds / 60) * CLIENT_RATES.USD[session.session_type]).toFixed(2)
    );

    if (session.client_balance < extensionCost) {
      socket.emit('extend-session-denied', {
        roomId,
        reason: 'insufficient_balance',
        required: extensionCost,
        balance: session.client_balance,
      });
      return;
    }

    await db.query(
      `UPDATE sessions SET booked_duration = booked_duration + $1
       WHERE id = $2`,
      [addedSeconds, session.id]
    );

    const { rows: updated } = await db.query(
      `SELECT booked_duration FROM sessions WHERE id = $1`,
      [session.id]
    );

    io.to(roomId).emit('extend-session-confirmed', {
      roomId,
      additionalMinutes,
      newDuration: Math.floor(updated[0].booked_duration / 60),
    });
  });

  // ── Payout request ───────────────────────────────────────────────────────────
  socket.on('request-payout', async ({ interpreterId, amount }) => {
    if (amount < MIN_PAYOUT) {
      socket.emit('payout-response', {
        ok: false,
        reason: `Minimum payout is $${MIN_PAYOUT}`,
      });
      return;
    }

    const { rows: walletRows } = await db.query(
      `SELECT balance FROM wallets WHERE user_id = $1 AND vault_type = 'interpreter'`,
      [interpreterId]
    );

    const balance = walletRows[0]?.balance ?? 0;

    if (balance < amount) {
      socket.emit('payout-response', {
        ok: false,
        reason: 'Requested amount exceeds available balance',
        balance,
      });
      return;
    }

    const { rows: reqRows } = await db.query(
      `INSERT INTO payout_requests (interpreter_id, amount, status, requested_at)
       VALUES ($1, $2, 'pending', NOW())
       RETURNING id, amount, status, requested_at`,
      [interpreterId, amount]
    );

    socket.emit('payout-response', {
      ok: true,
      request: reqRows[0],
    });
  });
}