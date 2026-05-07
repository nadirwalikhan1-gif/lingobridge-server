import { logger } from '../config/logger.mjs';
import { supabaseAdmin } from '../config/supabase.mjs';
import { getWalletByUserId } from '../db/walletRepo.mjs';
import { getSessionById, updateLastBilledAt } from '../db/sessionRepo.mjs';
import { endSession } from './sessionService.mjs';
import { BILLING_INTERVAL_MS, PRICE_PER_MINUTE } from '../utils/constants.mjs';
import { eventBus } from '../utils/eventBus.mjs';

// Map<sessionId, intervalId>
const billingIntervals = new Map();

/**
 * Calculate cost from started_at to now
 */
export function calculateCost(startedAt, currency, sessionType) {
  const now        = Date.now();
  const start      = new Date(startedAt).getTime();
  const rawSeconds = Math.max(0, Math.floor((now - start) / 1000));
  const minutes    = rawSeconds / 60;
  const rate       = PRICE_PER_MINUTE[currency]?.[sessionType] ?? 1.20;
  const cost       = parseFloat((minutes * rate).toFixed(2));
  return { rawSeconds, minutes, cost, rate };
}

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
  // Fetch session
  const session = await getSessionById(sessionId).catch(() => null);

  if (!session || session.status !== 'active') {
    stopBilling(sessionId);
    return;
  }

  // Update heartbeat
  await updateLastBilledAt(sessionId).catch(() => {});

  // Fetch wallet
  const wallet = await getWalletByUserId(session.client_id).catch(() => null);
  if (!wallet) { stopBilling(sessionId); return; }

  // Calculate current cost
  const { cost, rawSeconds } = calculateCost(
    session.started_at,
    session.currency || 'USD',
    session.session_type
  );

  const available = wallet.balance - wallet.reserved_balance;

  logger.debug({ sessionId, cost, available, rawSeconds }, 'Billing tick');

  // Update duration in DB every tick
  await supabaseAdmin
    .from('sessions')
    .update({ raw_duration_sec: rawSeconds })
    .eq('id', sessionId)
    .catch(() => {});

  // Auto-end if cost exceeds available balance
  if (cost >= available) {
    logger.warn({ sessionId, cost, available }, 'Balance exhausted — ending call');
    stopBilling(sessionId);

    // Notify both parties via socket
    if (io && session.agora_channel) {
      io.to(session.agora_channel).emit('call-ended', {
        reason:  'balance_exhausted',
        message: 'Call ended — insufficient balance',
      });
    }

    // Emit internal event
    eventBus.emit('session.balance_exhausted', { sessionId });

    // End session and deduct wallet
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
