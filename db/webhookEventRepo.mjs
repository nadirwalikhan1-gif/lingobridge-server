// db/webhookEventRepo.mjs
//
// Atomic idempotency guard for webhook processing. LemonSqueezy retries on
// any non-2xx response, so without this, a retried event could be processed
// (and credited) more than once.
//
// Pattern: claim the event_id BEFORE doing the actual work (wallet credit).
// If claiming fails (already claimed), it's a genuine duplicate — skip.
// If claiming succeeds but the actual work then fails, release the claim so
// a legitimate retry (the work failed transiently, not because it was a
// duplicate) can still succeed next time, rather than being permanently
// blocked.

import { supabaseAdmin } from '../config/supabase.mjs';

/**
 * Attempt to claim an event_id. Returns true if this is the first time
 * claiming it (proceed with processing), false if already claimed
 * (genuine duplicate — skip processing).
 */
export async function claimWebhookEvent(eventId, eventName) {
  const { data, error } = await supabaseAdmin
    .from('processed_webhook_events')
    .insert({ event_id: eventId, event_name: eventName })
    .select('event_id');

  if (error) {
    // Unique violation on event_id = already claimed = genuine duplicate
    if (error.code === '23505') return false;
    throw new Error(`Webhook event claim failed: ${error.message}`);
  }

  return Boolean(data?.length);
}

/**
 * Release a claim — used when processing fails AFTER claiming, so a
 * legitimate retry isn't permanently blocked by a transient failure.
 */
export async function releaseWebhookEventClaim(eventId) {
  await supabaseAdmin
    .from('processed_webhook_events')
    .delete()
    .eq('event_id', eventId);
}
