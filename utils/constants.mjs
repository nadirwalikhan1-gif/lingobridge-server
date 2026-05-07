// ── SESSION STATUSES ──────────────────────────────────────────
export const SESSION_STATUS = Object.freeze({
  PENDING:   'pending',
  ACTIVE:    'active',
  ENDED:     'ended',
  CANCELLED: 'cancelled',
  FAILED:    'failed',
});

// ── BILLING ───────────────────────────────────────────────────
/** Cost per minute by currency and session type */
export const PRICE_PER_MINUTE = Object.freeze({
  USD: { audio: 0.80, video: 1.20 },
  GBP: { audio: 0.65, video: 1.00 },
  CAD: { audio: 1.05, video: 1.55 },
});

/** Minimum balance required to start a call */
export const MINIMUM_BALANCE = Object.freeze({
  USD: { audio: 4.00,  video: 6.00  },
  GBP: { audio: 3.25,  video: 5.00  },
  CAD: { audio: 5.25,  video: 7.75  },
});

/** Amount reserved at call start (covers ~15 min) */
export const RESERVATION_AMOUNT = Object.freeze({
  USD: { audio: 12.00, video: 18.00 },
  GBP: { audio: 9.75,  video: 15.00 },
  CAD: { audio: 15.75, video: 23.25 },
});

/** Billing tick interval (ms) */
export const BILLING_INTERVAL_MS = 60_000;

/** Grace period before first billing tick (ms) */
export const BILLING_GRACE_MS = 5_000;

// ── JOBS ──────────────────────────────────────────────────────
/** Stale active sessions auto-ended after this many hours */
export const STALE_SESSION_THRESHOLD_HOURS = 3;

/** Stale pending reservations released after this many minutes */
export const STALE_RESERVATION_THRESHOLD_MINUTES = 2;

// ── SOCKET EVENTS (server → client) ──────────────────────────
export const SOCKET_EVENTS = Object.freeze({
  // Session
  CALL_ACCEPTED:   'call-accepted',
  CALL_ENDED:      'call-ended',
  CALL_CANCELLED:  'call-cancelled',

  // Wallet
  BALANCE_UPDATE:  'wallet:balance_update',

  // Errors
  ERROR:           'error',
});


// -- TIMEOUTS ------------------------------------------------------
export const RESERVATION_TIMEOUT_MS = 120_000; // 2 minutes
