-- ─────────────────────────────────────────────────────────────────────────────
-- Interpreter dashboard backend migration
-- Run this in Supabase SQL Editor before deploying the new socket handlers.
-- All changes are additive (new columns, new table) — nothing existing is
-- altered or dropped, so this is safe to run without affecting current
-- billing, matching, or call flow logic.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Three-state interpreter status (Online / Break / Offline) ────────────
-- is_available stays as-is (used by existing matching/request-routing logic —
-- NOT removed). status is a new, additive column purely for the dashboard's
-- three-state toggle and for distinguishing "on break" from "offline" in the UI.
ALTER TABLE interpreters
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'offline'
    CHECK (status IN ('online', 'break', 'offline'));

-- Backfill existing rows so status matches their current is_available value
UPDATE interpreters
SET status = CASE WHEN is_available THEN 'online' ELSE 'offline' END
WHERE status = 'offline' AND is_available = true;

-- ── 2. Interpreter notification/dashboard settings ───────────────────────────
-- Single jsonb column rather than one column per toggle — keeps this additive
-- and easy to extend later without another migration per new setting.
ALTER TABLE interpreters
  ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{
    "email_notifications": true,
    "sms_notifications": false,
    "new_request_alerts": true,
    "payout_notifications": true
  }'::jsonb;

-- ── 3. Support tickets ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS support_tickets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('client', 'interpreter', 'admin')),
  subject     text NOT NULL,
  message     text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  created_at  timestamp with time zone DEFAULT now(),
  updated_at  timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_user_id ON support_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status  ON support_tickets(status);

-- ── 4. Helpful indexes for the new dashboard queries ──────────────────────────
-- These queries will run on every dashboard page load, so index the columns
-- they filter/sort on. IF NOT EXISTS makes this safe to re-run.
CREATE INDEX IF NOT EXISTS idx_sessions_interpreter_id    ON sessions(interpreter_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user_vault     ON transactions(user_id, vault_type);
CREATE INDEX IF NOT EXISTS idx_session_ratings_session_id  ON session_ratings(session_id);

-- ── 5. Interpreter reviews view ───────────────────────────────────────────────
-- session_ratings has no direct interpreter_id — it only links via session_id,
-- and rated_by can be either the client OR the interpreter (both can rate each
-- other). This view does the join + filters to only ratings a client gave
-- about an interpreter (excludes the interpreter's own rating of the client).
CREATE OR REPLACE VIEW interpreter_reviews AS
SELECT
  sr.id,
  sr.session_id,
  s.interpreter_id,
  sr.rated_by AS client_id,
  sr.rating,
  sr.comment,
  sr.created_at,
  s.language,
  s.session_type
FROM session_ratings sr
JOIN sessions s ON s.id = sr.session_id
WHERE sr.rated_by = s.client_id;
