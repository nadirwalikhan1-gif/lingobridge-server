import { supabaseAdmin } from '../config/supabase.mjs';

/**
 * Insert a transaction record.
 * Vault-model aware: tracks vault_type and reference_id for audit trails.
 */
export async function insertTransaction({ 
  userId, 
  amount, 
  currency, 
  type, 
  description, 
  sessionId,
  referenceId,   // vault-model: links to session or other entity
  vaultType,     // vault-model: 'client' | 'interpreter' | 'platform'
}) {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .insert({
      user_id:      userId,
      amount,
      currency,
      type,
      description,
      session_id:   sessionId || null,
      reference_id: referenceId || sessionId || null,
      vault_type:   vaultType || null,
    })
    .select()
    .single();

  if (error) throw new Error(`Transaction insert failed: ${error.message}`);
  return data;
}

/**
 * Get transactions for a user (optionally filtered by vault type)
 */
export async function getTransactionsByUser(userId, limit = 20, offset = 0, vaultType = null) {
  let query = supabaseAdmin
    .from('transactions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (vaultType) {
    query = query.eq('vault_type', vaultType);
  }

  const { data, error } = await query;

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

  if (error?.code === '23505') return false;
  if (error) throw new Error(`Webhook log failed: ${error.message}`);
  return true;
}