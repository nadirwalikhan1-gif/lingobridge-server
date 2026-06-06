// ─── LingoBridge Server Constants ─────────────────────────────────────────────
// Single source of truth for all billing rates, thresholds, and vault config.
// NEVER import CLIENT_RATES into any frontend file.

// ─── Active session rates ──────────────────────────────────────────────────────

// What the CLIENT is charged per minute during an active session
export const CLIENT_RATES = {
  USD: { audio: 1.49, video: 1.79 },
};

// What the INTERPRETER earns per minute during an active session.
// Never sent to or displayed on the client side.
export const INTERPRETER_RATES = {
  USD: { audio: 0.45, video: 0.50 },
};

// ─── Hold billing ──────────────────────────────────────────────────────────────

// What the INTERPRETER earns per minute during any hold — flat, regardless of type.
export const INTERPRETER_HOLD_RATE = 0.10; // per minute

// What the CLIENT is charged per minute during hold, in three tiers.
// upTo is in MINUTES. Rates are explicit round figures, no multiplier math.
//
// Tier logic:
//   0–5 min hold   → client pays $0.00   (platform absorbs interpreter hold pay)
//   5–10 min hold  → client pays flat rate (audio $0.65, video $0.75)
//   10+ min hold   → client pays full active rate (audio $1.49, video $1.79)
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

// ─── Payout thresholds ─────────────────────────────────────────────────────────

// Interpreter must have at least this much in their vault before requesting payout.
// No maximum — they can request any amount above this threshold.
export const MIN_PAYOUT = 50.00;

// ─── Platform vault sentinel ───────────────────────────────────────────────────

// Fixed UUID used as user_id for the platform wallet row.
// Seeded once via migration — never belongs to a real user.
export const PLATFORM_VAULT_ID = '00000000-0000-0000-0000-000000000000';
// ─── Socket event name constants ──────────────────────────────────────────────
// Centralised event names used by both socket/index.mjs and client listeners.
// Prevents typo mismatches between emitter and listener.
export const SOCKET_EVENTS = {
  BALANCE_UPDATE:           'balance-update',
  CALL_ENDED:               'call-ended',
  HOLD_SESSION:             'hold-session',
  HOLD_RESUMED:             'hold-resumed',
  EXTEND_SESSION_CONFIRMED: 'extend-session-confirmed',
  EXTEND_SESSION_DENIED:    'extend-session-denied',
  PAYOUT_RESPONSE:          'payout-response',
  PENDING_REQUESTS:         'pending-requests',
  SESSION_ERROR:            'session-error',
};// ─── Reservation amounts ───────────────────────────────────────────────────────
// Amount held in client vault when a session is created (pending state).
// Released if the session is cancelled before it starts.
export const RESERVATION_AMOUNT = {
  USD: { audio: 5.00, video: 5.00 },
};// ─── Stale session cleanup ────────────────────────────────────────────────────
// Sessions still 'active' after this many hours are force-ended by the cron job.
export const STALE_SESSION_THRESHOLD_HOURS = 3;