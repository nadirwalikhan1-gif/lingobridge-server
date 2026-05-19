import { BILLING_RATES } from './constants.mjs';
/**
 * Calculate cost from started_at to now
 * Extracted from billingService to break circular dependency with sessionService
 */
export function calculateCost(startedAt, currency, sessionType) {
  const now        = Date.now();
  const start      = new Date(startedAt).getTime();
  const rawSeconds = Math.max(0, Math.floor((now - start) / 1000));
  const minutes    = rawSeconds / 60;
  const rate = BILLING_RATES[currency]?.[sessionType] ?? 1.20;
  const cost       = parseFloat((minutes * rate).toFixed(2));
  return { rawSeconds, minutes, cost, rate };
}