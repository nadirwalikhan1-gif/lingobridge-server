import { logger } from '../config/logger.mjs';
import db from '../db/index.mjs';
import {
  CLIENT_RATES,
  INTERPRETER_RATES,
  INTERPRETER_HOLD_RATE,
  HOLD_TIERS,
  PLATFORM_VAULT_ID,
  BILLING_INTERVAL_MS,
} from '../utils/constants.mjs';
import { eventBus } from '../utils/eventBus.mjs';

// Legacy tracking (callers still invoke startBilling/stopBilling)
const activeSessions = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Calculate client charge for one 60s tick of hold time.
 * Uses flat-rate tiers per session type.
 */
function holdClientCharge(priorHoldSeconds, tickSeconds, sessionType) {
  const tiers = HOLD_TIERS[sessionType];
  let charge = 0;
  let cursor = priorHoldSeconds;
  let covered = 0;

  for (const tier of tiers) {
    const tierEndSeconds = tier.upTo * 60;
    if (cursor >= tierEndSeconds) continue;

    const availableInTier = tierEndSeconds - cursor;
    const secondsInTier = Math.min(tickSeconds - covered, availableInTier);
    if (secondsInTier <= 0) break;

    charge += (secondsInTier / 60) * tier.rate;
    covered += secondsInTier;
    cursor += secondsInTier;

    if (covered >= tickSeconds) break;
  }

  return parseFloat(charge.toFixed(4));
}

/**
 * Atomic 3-vault transfer. Throws 'INSUFFICIENT_BALANCE' if client can't pay.
 */
async function transferFunds({ clientId, interpreterId, clientCharge, interpreterEarning }) {
  const platformEarning = parseFloat((clientCharge - interpreterEarning).toFixed(4));

  await db.query('BEGIN');
  try {
    const clientRes = await db.query(
      `UPDATE wallets SET balance = balance - $1
       WHERE user_id = $2 AND vault_type = 'client' AND balance >= $1
       RETURNING *`,
      [clientCharge, clientId]
    );

    if (clientRes.rowCount === 0) {
      throw new Error('INSUFFICIENT_BALANCE');
    }

    await db.query(
      `UPDATE wallets SET balance = balance + $1
       WHERE user_id = $2 AND vault_type = 'interpreter'`,
      [interpreterEarning, interpreterId]
    );

    await db.query(
      `UPDATE wallets SET balance = balance + $1
       WHERE user_id = $2 AND vault_type = 'platform'`,
      [platformEarning, PLATFORM_VAULT_ID]
    );

    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

// ─── Active billing tick (called every 60s by server entry point) ─────────────

export async function billingTick() {
  const { rows: sessions } = await db.query(
    `SELECT id, client_id, interpreter_id, session_type, agora_channel
     FROM sessions
     WHERE status = 'active' AND on_hold = false`
  );

  for (const session of sessions) {
    try {
      const clientRate = CLIENT_RATES.USD[session.session_type];
      const interpreterRate = INTERPRETER_RATES.USD[session.session_type];

      await transferFunds({
        clientId: session.client_id,
        interpreterId: session.interpreter_id,
        clientCharge: parseFloat(clientRate.toFixed(4)),
        interpreterEarning: parseFloat(interpreterRate.toFixed(4)),
      });

      // Ledger audit trail
      await db.query(
        `INSERT INTO transactions (user_id, type, amount, reference_id, created_at)
         VALUES ($1,'charge',$2,$3,NOW()),
                ($4,'earning',$5,$3,NOW()),
                ($6,'platform_revenue',$7,$3,NOW())`,
        [
          session.client_id, clientRate,
          session.id,
          session.interpreter_id, interpreterRate,
          PLATFORM_VAULT_ID, parseFloat((clientRate - interpreterRate).toFixed(4)),
        ]
      );

      logger.debug({ sessionId: session.id }, 'Active billing tick processed');
    } catch (err) {
      if (err.message === 'INSUFFICIENT_BALANCE') {
        logger.warn({ sessionId: session.id }, 'Balance exhausted — ending session');

        await db.query(
          `UPDATE sessions
           SET status = 'completed', ended_at = NOW(), end_reason = 'balance_exhausted'
           WHERE id = $1`,
          [session.id]
        );

        eventBus.emit('session.balance_exhausted', {
          sessionId: session.id,
          channelId: session.agora_channel,
        });
        continue;
      }

      logger.error({ err, sessionId: session.id }, 'Active billing tick failed');
    }
  }
}

// ─── Hold billing tick (called every 60s by server entry point) ───────────────

export async function holdBillingTick() {
  const { rows: heldSessions } = await db.query(
    `SELECT id, client_id, interpreter_id, session_type,
            total_hold_seconds, hold_started_at
     FROM sessions
     WHERE status = 'active' AND on_hold = true AND hold_started_at IS NOT NULL`
  );

  for (const session of heldSessions) {
    try {
      const priorHoldSeconds = session.total_hold_seconds ?? 0;
      const tickSeconds = 60;

      const clientCharge = holdClientCharge(priorHoldSeconds, tickSeconds, session.session_type);
      const interpreterEarning = parseFloat((INTERPRETER_HOLD_RATE * (tickSeconds / 60)).toFixed(4));

      if (clientCharge > 0 || interpreterEarning > 0) {
        const platformDelta = parseFloat((clientCharge - interpreterEarning).toFixed(4));

        await db.query('BEGIN');
        try {
          if (clientCharge > 0) {
            await db.query(
              `UPDATE wallets SET balance = balance - $1
               WHERE user_id = $2 AND vault_type = 'client'`,
              [clientCharge, session.client_id]
            );
          }

          await db.query(
            `UPDATE wallets SET balance = balance + $1
             WHERE user_id = $2 AND vault_type = 'interpreter'`,
            [interpreterEarning, session.interpreter_id]
          );

          await db.query(
            `UPDATE wallets SET balance = balance + $1
             WHERE user_id = $2 AND vault_type = 'platform'`,
            [platformDelta, PLATFORM_VAULT_ID]
          );

          await db.query(
            `UPDATE sessions SET total_hold_seconds = total_hold_seconds + $1
             WHERE id = $2`,
            [tickSeconds, session.id]
          );

          await db.query('COMMIT');
        } catch (err) {
          await db.query('ROLLBACK');
          throw err;
        }
      }

      logger.debug({ sessionId: session.id }, 'Hold billing tick processed');
    } catch (err) {
      logger.error({ err, sessionId: session.id }, 'Hold billing tick failed');
    }
  }
}

// ─── End session — closes record (per-minute billing already handled) ─────────

export async function endSession(sessionId) {
  const { rows } = await db.query(
    `UPDATE sessions SET status = 'completed', ended_at = NOW()
     WHERE id = $1 AND status = 'active'
     RETURNING *`,
    [sessionId]
  );

  if (!rows.length) return null;
  logger.info({ sessionId }, 'Session ended');
  return rows[0];
}

// ─── Legacy compatibility wrappers ───────────────────────────────────────────

export function startBilling(sessionId, io) {
  activeSessions.set(sessionId, { io });
  logger.info({ sessionId }, 'Billing tracked (global tick handles actual billing)');
}

export function stopBilling(sessionId) {
  activeSessions.delete(sessionId);
  logger.info({ sessionId }, 'Billing untracked');
}

export function stopAllBilling() {
  activeSessions.clear();
  logger.info('All billing tracking cleared');
}

export function getActiveBillingCount() {
  return activeSessions.size;
}