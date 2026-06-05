/**
 * Single source of truth for all pricing constants.
 * Server-side only — interpreter rates must never reach the client.
 */

export const CURRENCIES = ['USD'];

export const SESSION_TYPES = ['audio', 'video'];

// ─── Client billing rates (what the CLIENT pays per active minute) ───────────
export const CLIENT_RATES = {
  USD: { audio: 1.49, video: 1.79 },
};

// ─── Interpreter earnings (what the INTERPRETER earns per active minute) ─────
export const INTERPRETER_RATES = {
  USD: { audio: 0.45, video: 0.50 },
};

// ─── Interpreter hold earnings (flat rate, any hold time, any session type) ──
export const INTERPRETER_HOLD_RATE = 0.10; // per minute

// ─── Hold billing tiers — flat client rates per session type ─────────────────
export const HOLD_TIERS = {
  audio: [
    { upTo: 5,        rate: 0.00 },
    { upTo: 10,       rate: 0.65 },
    { upTo: Infinity, rate: 1.49 },
  ],
  video: [
    { upTo: 5,        rate: 0.00 },
    { upTo: 10,       rate: 0.75 },
    { upTo: Infinity, rate: 1.79 },
  ],
};

// ─── Payout ──────────────────────────────────────────────────────────────────
export const MIN_PAYOUT = 50.00;

// ─── Platform vault sentinel (seeded once in DB) ─────────────────────────────
export const PLATFORM_VAULT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Reservation amounts (held when call is requested, released if not accepted)
 */
export const RESERVATION_AMOUNT = {
  USD: { audio: 0, video: 0 },
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
 * Stale session threshold
 */
export const STALE_SESSION_THRESHOLD_HOURS = 3;

/**
 * Socket event names
 */
export const SOCKET_EVENTS = {
  BALANCE_UPDATE:    'balance-update',
  CALL_REQUESTED:    'call-requested',
  CALL_ACCEPTED:     'call-accepted',
  CALL_REJECTED:     'call-rejected',
  CALL_ENDED:        'call-ended',
  NEW_REQUEST:       'new-request',
  REQUEST_CANCELLED: 'request-cancelled',
  ERROR:             'error',
};

/**
 * EventBus events
 */
export const EVENTS = {
  WALLET_CREDITED: 'wallet:credited',
  SESSION_STARTED: 'session:started',
  SESSION_ENDED:   'session:ended',
};

/**
 * Billing interval (how often to bill during a session, in ms)
 */
export const BILLING_INTERVAL_MS = 60_000; // bill every 60 seconds