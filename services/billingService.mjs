import { logger } from '../config/logger.mjs';
import { supabaseAdmin } from '../config/supabase.mjs';
import { getWalletByUserId } from '../db/walletRepo.mjs';
import { getSessionById, updateLastBilledAt } from '../db/sessionRepo.mjs';
import { endSession } from './sessionService.mjs';
import { BILLING_INTERVAL_MS } from '../utils/constants.mjs';
import { eventBus } from '../utils/eventBus.mjs';
// FIX: import calculateCost from utils instead of defining here (breaks circular dependency)
import { calculateCost } from '../utils/billing.mjs';

// Map<sessionId, intervalId>
const billingIntervals = new Map();

/**
 * Start billing loop for a session
 */
export function startBilling(sessionId, io) {
  if (billingIntervals.has(sessionId)) {
    logger.warn({ sessionId }, 'Billing already running');
    return;
  }

  logger.info({ sessionId }, 'Billing started');

  const interval = setInterval(async () => {
    try {
      await billingTick(sessionId, io);
    } catch (err) {
      logger.error({ err, sessionId }, 'Billing tick error');
      stopBilling(sessionId);
    }
  }, BILLING_INTERVAL_MS);

  billingIntervals.set(sessionId, interval);
}

/**
 * Single billing tick — checks balance, auto-ends if exhausted
 */
async function billingTick(sessionId, io) {
  const session = await getSessionById(sessionId).catch(() => null);

  if (!session || session.status !== 'active') {
    stopBilling(sessionId);
    return;
  }

  await updateLastBilledAt(sessionId).catch(() => {});

  const wallet = await getWalletByUserId(session.client_id).catch(() => null);
  if (!wallet) { stopBilling(sessionId); return; }

  const { cost, rawSeconds } = calculateCost(
    session.started_at,
    session.currency || 'USD',
    session.session_type
  );

  const available = wallet.balance - wallet.reserved_balance;

  logger.debug({ sessionId, cost, available, rawSeconds }, 'Billing tick');

  await supabaseAdmin
    .from('sessions')
    .update({ raw_duration_sec: rawSeconds })
    .eq('id', sessionId)
    .catch(() => {});

  if (cost >= available) {
    logger.warn({ sessionId, cost, available }, 'Balance exhausted — ending call');
    stopBilling(sessionId);

    if (io && session.agora_channel) {
      io.to(session.agora_channel).emit('call-ended', {
        reason:  'balance_exhausted',
        message: 'Call ended — insufficient balance',
      });
    }

    eventBus.emit('session.balance_exhausted', { sessionId });
    await endSession(sessionId, 'balance_exhausted');
  }
}

/**
 * Stop billing for a session
 */
export function stopBilling(sessionId) {
  const interval = billingIntervals.get(sessionId);
  if (interval) {
    clearInterval(interval);
    billingIntervals.delete(sessionId);
    logger.info({ sessionId }, 'Billing stopped');
  }
}

/**
 * Stop all billing loops (on shutdown)
 */
export function stopAllBilling() {
  billingIntervals.forEach((_, sessionId) => stopBilling(sessionId));
  logger.info('All billing engines stopped');
}

/**
 * How many sessions are currently being billed
 */
export function getActiveBillingCount() {
  return billingIntervals.size;
}