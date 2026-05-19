/**
 * Single source of truth for all pricing constants.
 * Used by both server and (via API) client.
 */

export const CURRENCIES = ['USD', 'GBP', 'CAD', 'EUR', 'AUD'];

export const SESSION_TYPES = ['audio', 'video'];

/**
 * Per-minute billing rates (in each currency)
 */
export const BILLING_RATES = {
  USD: { audio: 0.50, video: 1.00 },
  GBP: { audio: 0.40, video: 0.80 },
  CAD: { audio: 0.60, video: 1.20 },
  EUR: { audio: 0.45, video: 0.90 },
  AUD: { audio: 0.70, video: 1.40 },
};

/**
 * Reservation amounts (held when call is requested, released if not accepted)
 */
export const RESERVATION_AMOUNT = {
  USD: { audio: 9.00,  video: 18.00 },
  GBP: { audio: 7.50,  video: 15.00 },
  CAD: { audio: 10.00, video: 20.00 },
  EUR: { audio: 8.00,  video: 16.00 },
  AUD: { audio: 11.00, video: 22.00 },
};

/**
 * Minimum wallet top-up amounts
 */
export const TOPUP_AMOUNTS = [10, 25, 50, 100];

/**
 * LemonSqueezy product/variant IDs — loaded from env, with safe fallbacks
 * that only work in development (will fail in production if not set)
 */
export const LEMON_VARIANTS = {
  pro:  process.env.LEMONSQUEEZY_VARIANT_ID_PRO  || null,
  team: process.env.LEMONSQUEEZY_VARIANT_ID_TEAM || null,
};

export const LEMON_WEBHOOK_SECRET = process.env.LEMONSQUEEZY_WEBHOOK_SECRET || null;

/**
 * Agora config
 */
export const AGORA_CONFIG = {
  appId:     process.env.AGORA_APP_ID     || null,
  appCert:   process.env.AGORA_APP_CERT   || null,
};

/**
 * Interpreter revenue share (percentage kept by interpreter)
 */
export const REVENUE_SHARE = 0.70; // 70% to interpreter, 30% to platform

/**
 * Stale session threshold
 */
export const STALE_SESSION_THRESHOLD_HOURS = 3;

/**
 * Socket event names
 */
export const SOCKET_EVENTS = {
  BALANCE_UPDATE:   'balance-update',
  CALL_REQUESTED:   'call-requested',
  CALL_ACCEPTED:    'call-accepted',
  CALL_REJECTED:    'call-rejected',
  CALL_ENDED:       'call-ended',
  NEW_REQUEST:      'new-request',
  REQUEST_CANCELLED:'request-cancelled',
  ERROR:            'error',
};

/**
 * EventBus events
 */
export const EVENTS = {
  WALLET_CREDITED:  'wallet:credited',
  SESSION_STARTED:  'session:started',
  SESSION_ENDED:    'session:ended',
};
/**
 * Billing interval (how often to bill during a session, in ms)
 */
export const BILLING_INTERVAL_MS = 60_000; // bill every 60 seconds