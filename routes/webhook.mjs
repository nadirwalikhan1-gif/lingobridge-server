import { Router } from 'express';
import { verifyWebhookSignature, processOrderCreated } from '../services/paymentService.mjs';
import { logger } from '../config/logger.mjs';

const router = Router();

/**
 * POST /webhook/lemonsqueezy
 *
 * Raw body is collected by server.mjs middleware BEFORE express.json().
 *
 * Design decisions:
 * - Process BEFORE sending 200. Lemon Squeezy retries on non-2xx, so if we
 *   return 200 then crash we lose the event permanently. Processing first
 *   means LS will retry on 5xx — safe because we're idempotent.
 * - Signature verified before any DB work.
 * - Unknown events return 200 immediately (don't retry irrelevant events).
 */
router.post('/', async (req, res) => {
  const signature = req.headers['x-signature'];
  const rawBody   = req.rawBody;

  // ── 1. Guard: raw body must be present ──────────────────────
  if (!rawBody) {
    logger.error('Webhook received with no raw body — check server.mjs middleware order');
    return res.status(400).json({ error: 'No raw body' });
  }

  // ── 2. Verify signature ──────────────────────────────────────
  if (!verifyWebhookSignature(rawBody, signature)) {
    logger.warn({ ip: req.ip }, 'Webhook signature verification failed');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // ── 3. Parse JSON ────────────────────────────────────────────
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    logger.warn({ ip: req.ip }, 'Webhook received invalid JSON');
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const eventName = payload?.meta?.event_name;
  const eventId   = payload?.meta?.event_id ?? payload?.data?.id;
  logger.info({ eventName, eventId }, 'Webhook received');

  // ── 4. Route event ───────────────────────────────────────────
  if (eventName === 'order_created') {
    try {
      const result = await processOrderCreated(payload);
      if (result.duplicate) {
        return res.status(200).json({ received: true, duplicate: true });
      }
      return res.status(200).json({ received: true });
    } catch (err) {
      // Return 5xx so Lemon Squeezy retries — we're idempotent so safe
      logger.error({ err, eventName, eventId }, 'Webhook processing failed');
      return res.status(500).json({ error: 'Processing failed' });
    }
  }

  // Unknown event — acknowledge without processing
  logger.info({ eventName }, 'Unhandled webhook event type — ignoring');
  return res.status(200).json({ received: true, handled: false });
});

export default router;
