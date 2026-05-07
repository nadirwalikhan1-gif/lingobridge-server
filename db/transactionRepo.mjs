import { supabaseAdmin } from '../config/supabase.mjs';

/**
 * Insert a transaction record
 */
export async function insertTransaction({ userId, amount, currency, type, description, sessionId }) {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .insert({
      user_id:     userId,
      amount,
      currency,
      type,
      description,
      session_id:  sessionId || null,
    })
    .select()
    .single();

  if (error) throw new Error(`Transaction insert failed: ${error.message}`);
  return data;
}

/**
 * Get transactions for a user
 */
export async function getTransactionsByUser(userId, limit = 20, offset = 0) {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(`Transactions fetch failed: ${error.message}`);
  return data || [];
}

/**
 * Check if a webhook event was already processed (idempotency)
 */
export async function isWebhookProcessed(eventId) {
  const { data } = await supabaseAdmin
    .from('webhook_events')
    .select('id')
    .eq('event_id', eventId)
    .single();

  return !!data;
}

/**
 * Log webhook event
 */
export async function logWebhookEvent({ eventId, provider, payload }) {
  const { error } = await supabaseAdmin
    .from('webhook_events')
    .insert({
      event_id:     eventId,
      provider,
      payload,
      processed_at: new Date().toISOString(),
    });

  // Unique constraint violation = duplicate — return false
  if (error?.code === '23505') return false;
  if (error) throw new Error(`Webhook log failed: ${error.message}`);
  return true;
}
