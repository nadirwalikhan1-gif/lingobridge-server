import { supabaseAdmin } from '../config/supabase.mjs';
import { NotFoundError } from '../utils/errors.mjs';

/**
 * Get wallet by user ID
 */
export async function getWalletByUserId(userId) {
  const { data, error } = await supabaseAdmin
    .from('wallets')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (error || !data) throw new NotFoundError('Wallet');
  return data;
}

/**
 * Get available balance (balance - reserved_balance)
 */
export async function getAvailableBalance(userId) {
  const wallet = await getWalletByUserId(userId);
  return {
    balance:          wallet.balance,
    reservedBalance:  wallet.reserved_balance,
    availableBalance: wallet.balance - wallet.reserved_balance,
    currency:         wallet.currency,
  };
}

/**
 * Credit wallet atomically via DB RPC.
 *
 * FIX: The previous implementation used:
 *   supabaseAdmin.rpc('increment', { x: amount }) as a column value inside .update()
 * This is INVALID in Supabase JS v2 — rpc() returns a query builder, not a scalar.
 * That call silently set balance = [object Object] or errored.
 *
 * Correct approach: delegate to a Postgres function that does:
 *   UPDATE wallets SET balance = balance + p_amount WHERE user_id = p_user_id
 * This is atomic and race-condition-safe.
 *
 * Required SQL (run once in Supabase SQL editor):
 * ─────────────────────────────────────────────
 * CREATE OR REPLACE FUNCTION credit_wallet_topup(p_user_id uuid, p_amount numeric)
 * RETURNS wallets LANGUAGE plpgsql AS $$
 * DECLARE v_wallet wallets;
 * BEGIN
 *   UPDATE wallets
 *   SET balance    = balance + p_amount,
 *       updated_at = now()
 *   WHERE user_id = p_user_id
 *   RETURNING * INTO v_wallet;
 *   IF NOT FOUND THEN RAISE EXCEPTION 'Wallet not found for user %', p_user_id; END IF;
 *   RETURN v_wallet;
 * END; $$;
 * ─────────────────────────────────────────────
 *
 * @returns {object} updated wallet row
 */
export async function creditWallet(userId, amount) {
  const { data, error } = await supabaseAdmin
    .rpc('credit_wallet_topup', {
      p_user_id: userId,
      p_amount:  amount,
    });

  if (error) throw new Error(`Wallet credit failed: ${error.message}`);
  if (!data) throw new NotFoundError('Wallet');
  return data;
}

/**
 * Reserve funds atomically via DB function
 */
export async function reserveFunds(userId, amount) {
  const { data, error } = await supabaseAdmin
    .rpc('reserve_wallet_funds', {
      p_user_id: userId,
      p_amount:  amount,
    });

  if (error) throw new Error(`Reserve RPC failed: ${error.message}`);
  return data;
}

/**
 * Release reservation via DB function
 */
export async function releaseReservation(userId, amount) {
  const { error } = await supabaseAdmin
    .rpc('release_wallet_reservation', {
      p_user_id: userId,
      p_amount:  amount,
    });

  if (error) throw new Error(`Release RPC failed: ${error.message}`);
}

/**
 * Atomic deduction via DB function (with SELECT FOR UPDATE)
 */
export async function deductWallet(userId, sessionId, amount, description) {
  const { data, error } = await supabaseAdmin
    .rpc('deduct_wallet_for_session', {
      p_user_id:     userId,
      p_session_id:  sessionId,
      p_amount:      amount,
      p_description: description,
    });

  if (error) throw new Error(`Deduction RPC failed: ${error.message}`);
  return data;
}

/**
 * Get stale pending reservations older than threshold.
 * Used by releaseReservations cron job.
 */
export async function getStaleReservations(thresholdMinutes = 2) {
  const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000).toISOString();

  const { data, error } = await supabaseAdmin
    .from('sessions')
    .select('id, client_id, currency, session_type')
    .eq('status', 'pending')
    .lt('created_at', cutoff);

  if (error) throw new Error(`Stale reservation fetch failed: ${error.message}`);
  return data || [];
}
