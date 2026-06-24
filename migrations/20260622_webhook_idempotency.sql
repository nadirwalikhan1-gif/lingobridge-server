-- ─────────────────────────────────────────────────────────────────────────────
-- Webhook idempotency migration
-- Closes a real double-credit risk: the LemonSqueezy webhook handler's
-- comments claimed idempotency but never actually implemented it. LS retries
-- on any non-2xx response — without this table, a retried event could credit
-- the same payment to a wallet multiple times.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS processed_webhook_events (
  event_id    text PRIMARY KEY,
  event_name  text,
  created_at  timestamp with time zone DEFAULT now()
);
