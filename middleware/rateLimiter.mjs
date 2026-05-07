import rateLimit from 'express-rate-limit';
import { logger } from '../config/logger.mjs';

// ── HTTP LIMITERS ─────────────────────────────────────────────

/** Sensitive endpoints: checkout, agora token. 20 req/min per IP. */
export const strictLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             20,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many requests — slow down' },
  handler(req, res, next, options) {
    logger.warn({ ip: req.ip, path: req.path }, 'Rate limit exceeded (strict)');
    res.status(options.statusCode).json(options.message);
  },
});

/** Webhook receivers. 200 req/min per IP. */
export const webhookLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             200,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many webhook requests' },
});

/** General routes. 100 req/min per IP. */
export const generalLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             100,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many requests — slow down' },
});

// ── SOCKET RATE LIMITER ───────────────────────────────────────

/**
 * Per-socket, per-event rate limiter for Socket.IO handlers.
 *
 * FIX: acceptHandler and endCallHandler imported rateLimitSocket but it
 * didn't exist — every socket event threw "rateLimitSocket is not a function".
 *
 * Simple in-memory token bucket: max N events per window per socket.
 * For multi-instance deployments, move counters to Redis.
 *
 * @param {object} socket         — Socket.IO socket
 * @param {string} eventName      — event being rate-limited
 * @param {object} [options]
 * @param {number} [options.max=5]         — max events per window
 * @param {number} [options.windowMs=10000] — window in ms
 * @returns {boolean} true = allowed, false = rate-limited (emit error to socket)
 */
export function rateLimitSocket(socket, eventName, { max = 5, windowMs = 10_000 } = {}) {
  if (!socket._rateLimits) socket._rateLimits = {};

  const key = eventName;
  const now = Date.now();
  const entry = socket._rateLimits[key];

  if (!entry || now - entry.windowStart > windowMs) {
    // New window
    socket._rateLimits[key] = { count: 1, windowStart: now };
    return true;
  }

  if (entry.count >= max) {
    logger.warn(
      { socketId: socket.id, userId: socket.userId, eventName },
      'Socket rate limit exceeded'
    );
    socket.emit('error', { code: 'RATE_LIMITED', message: 'Too many requests — slow down' });
    return false;
  }

  entry.count += 1;
  return true;
}
