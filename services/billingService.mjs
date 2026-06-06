// ─── LingoBridge Billing Service ──────────────────────────────────────────────
// Handles all money movement between the three vaults:
//   • Client vault      — prepaid by client, debited each active tick
//   • Interpreter vault — credited each active tick and during hold ticks
//   • Platform vault    — receives the spread; absorbs free-tier hold cost
//
// Two independent intervals registered in server.mjs:
//   setInterval(billingTick,     60_000)   ← active sessions
//   setInterval(holdBillingTick, 60_000)   ← held sessions
//
// endSession() only closes the session record — per-minute billing has already
// been handled tick-by-tick throughout the session lifetime.

import { creditWallet, deductWallet } from '../db/walletRepo.mjs';
import {
  getActiveBillableSessions,
  getHeldSessions,
  incrementHoldSeconds,
  endSessionInsufficientFunds,
  completeSession,
} from '../db/sessionRepo.mjs';
import { insertTransaction } from '../db/transactionRepo.mjs';
import {
  CLIENT_RATES,
  INTERPRETER_RATES,
  INTERPRETER_HOLD_RATE,
  HOLD_TIERS,
  PLATFORM_VAULT_ID,
} from '../utils/constants.mjs';

// ─── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Calculate the client charge for one billing tick of hold time.
 *
 * Hold is charged in tiers based on cumulative hold seconds already elapsed
 * BEFORE this tick. A single tick can span multiple tiers (e.g. if the tick
 * straddles the 5-minute boundary, seconds on each side are rated separately).
 *
 * @param {number} priorHoldSeconds  Cumulative hold seconds before this tick
 * @param {number} tickSeconds       Duration of this tick (normally 60)
 * @param {string} sessionType       'audio' | 'video'
 * @returns {number} Dollar amount to charge the client (4 decimal precision)
 */
function holdClientCharge(priorHoldSeconds, tickSeconds, sessionType) {
  const tiers = HOLD_TIERS[sessionType] || HOLD_TIERS.audio;
  let charge  = 0;
  let cursor  = priorHoldSeconds; // seconds into cumulative hold at tick start
  let covered = 0;                // seconds of this tick already accounted for

  for (const tier of tiers) {
    const tierEndSeconds = tier.upTo * 60;
    if (cursor >= tierEndSeconds) continue;

    const availableInTier = tierEndSeconds - cursor;
    const secondsInTier   = Math.min(tickSeconds - covered, availableInTier);
    if (secondsInTier <= 0) break;

    charge  += (secondsInTier / 60) * tier.rate;
    covered += secondsInTier;
    cursor  += secondsInTier;

    if (covered >= tickSeconds) break;
  }

  return parseFloat(charge.toFixed(4));
}

/**
 * Move money across all three vaults and write ledger entries.
 * platformAmount may be negative during the hold free tier — the platform
 * absorbs the cost of interpreter hold pay in that window.
 *
 * Uses deductWallet (SELECT FOR UPDATE via RPC) for the client deduction
 * so concurrent ticks cannot double-spend.
 *
 * @returns {{ ok: boolean, reason?: string }}
 */
async function transferAndLog({
  sessionId,
  clientId,
  interpreterId,
  clientCharge,
  interpreterEarning,
  currency = 'USD',
  tickType,           // 'active' | 'hold'
}) {
  const platformEarning = parseFloat((clientCharge - interpreterEarning).toFixed(4));

  try {
    // 1. Debit client vault (atomic, guarded against insufficient funds)
    if (clientCharge > 0) {
      const result = await deductWallet(
        clientId,
        sessionId,
        clientCharge,
        `Session ${tickType} billing`,
        'client'
      );

      if (!result?.success) {
        return { ok: false, reason: result?.reason || 'insufficient_funds' };
      }
    }

    // 2. Credit interpreter vault
    if (interpreterEarning > 0) {
      await creditWallet(interpreterId, interpreterEarning, 'interpreter');
    }

    // 3. Credit or debit platform vault
    // platformEarning is negative in the free hold tier — creditWallet with a
    // negative amount is intentional and supported by the RPC.
    await creditWallet(PLATFORM_VAULT_ID, platformEarning, 'platform');

    // 4. Write ledger rows for full audit trail
    await Promise.all([
      insertTransaction({
        userId:      clientId,
        amount:      clientCharge,
        currency,
        type:        `charge_${tickType}`,
        description: `Session ${tickType} charge`,
        sessionId,
        referenceId: sessionId,
        vaultType:   'client',
      }),
      interpreterEarning > 0 && insertTransaction({
        userId:      interpreterId,
        amount:      interpreterEarning,
        currency,
        type:        'earning',
        description: `Session ${tickType} earning`,
        sessionId,
        referenceId: sessionId,
        vaultType:   'interpreter',
      }),
      insertTransaction({
        userId:      PLATFORM_VAULT_ID,
        amount:      platformEarning,
        currency,
        type:        'platform_revenue',
        description: `Session ${tickType} platform revenue`,
        sessionId,
        referenceId: sessionId,
        vaultType:   'platform',
      }),
    ].filter(Boolean));

    return { ok: true };
  } catch (err) {
    console.error(`[billing] transferAndLog error (${tickType}):`, err.message);
    return { ok: false, reason: err.message };
  }
}

// ─── Active session billing tick ──────────────────────────────────────────────

/**
 * Called every 60 seconds. Bills one minute of active time for every session
 * that is active AND not on hold.
 */
export async function billingTick() {
  let sessions;
  try {
    sessions = await getActiveBillableSessions();
  } catch (err) {
    console.error('[billingTick] fetch error:', err.message);
    return;
  }

  for (const session of sessions) {
    const currency         = session.currency || 'USD';
    const clientCharge     = CLIENT_RATES[currency]?.[session.session_type]
                          ?? CLIENT_RATES.USD[session.session_type];
    const interpreterEarning = INTERPRETER_RATES[currency]?.[session.session_type]
                            ?? INTERPRETER_RATES.USD[session.session_type];

    const result = await transferAndLog({
      sessionId:         session.id,
      clientId:          session.client_id,
      interpreterId:     session.interpreter_id,
      clientCharge,
      interpreterEarning,
      currency,
      tickType:          'active',
    });

    if (!result.ok && result.reason === 'insufficient_funds') {
      console.warn(`[billingTick] Client out of funds — ending session ${session.id}`);
      await endSessionInsufficientFunds(session.id);
    }
  }
}

// ─── Hold billing tick ────────────────────────────────────────────────────────

/**
 * Called every 60 seconds independently of billingTick.
 * Charges held sessions per HOLD_TIERS and always credits the interpreter
 * INTERPRETER_HOLD_RATE regardless of what the client owes.
 */
export async function holdBillingTick() {
  let heldSessions;
  try {
    heldSessions = await getHeldSessions();
  } catch (err) {
    console.error('[holdBillingTick] fetch error:', err.message);
    return;
  }

  for (const session of heldSessions) {
    const tickSeconds        = 60;
    const priorHoldSeconds   = session.total_hold_seconds ?? 0;
    const currency           = session.currency || 'USD';

    const clientCharge       = holdClientCharge(priorHoldSeconds, tickSeconds, session.session_type);
    const interpreterEarning = parseFloat((INTERPRETER_HOLD_RATE * (tickSeconds / 60)).toFixed(4));

    await transferAndLog({
      sessionId:         session.id,
      clientId:          session.client_id,
      interpreterId:     session.interpreter_id,
      clientCharge,
      interpreterEarning,
      currency,
      tickType:          'hold',
    });

    // Always advance the hold seconds counter so tier boundaries are respected
    await incrementHoldSeconds(session.id, tickSeconds);
  }
}

// ─── End session ──────────────────────────────────────────────────────────────

/**
 * Marks the session completed and returns the final row.
 * No lump-sum charge here — billing was handled tick-by-tick.
 * Called by the socket end-call handler (endCallHandler.mjs).
 */
export async function endSession(sessionId) {
  try {
    return await completeSession(sessionId);
  } catch (err) {
    console.error('[endSession] error:', err.message);
    return null;
  }
}
