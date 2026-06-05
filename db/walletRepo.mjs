import { supabaseAdmin } from '../config/supabase.mjs';
import { NotFoundError } from '../utils/errors.mjs';

/**
 * Get wallet by user ID and vault type.
 * Vault types: 'client' | 'interpreter' | 'platform'
 */
export async function getWalletByUserId(userId, vaultType = 'client') {
  const { data, error } = await supabaseAdmin
    .from('wallets')
    .select('*')
    .eq('user_id', userId)
    .eq('vault_type', vaultType)
    .single();

  if (error || !data) throw new NotFoundError(`Wallet (${vaultType})`);
  return data;
}

/**
 * Get available balance for a specific vault.
 */
export async function getAvailableBalance(userId, vaultType = 'client') {
  const wallet = await getWalletByUserId(userId, vaultType);
  return {
    balance:          wallet.balance,
    reservedBalance:  wallet.reserved_balance,
    availableBalance: wallet.balance - wallet.reserved_balance,
    currency:         wallet.currency,
    vaultType:        wallet.vault_type,
  };
}

/**
 * Credit wallet atomically via DB RPC.
 *
 * NOTE: The Postgres function `credit_wallet_topup` must accept `p_vault_type`.
 * If your SQL function doesn't have it yet, run this migration:
 *
 * ── SQL MIGRATION ─────────────────────────────────────────────
 * CREATE OR REPLACE FUNCTION credit_wallet_topup(
 *   p_user_id UUID,
 *   p_amount  NUMERIC,
 *   p_vault_type TEXT DEFAULT 'client'
 * ) RETURNS wallets LANGUAGE plpgsql AS $$
 * DECLARE v_wallet wallets;
 * BEGIN
 *   UPDATE wallets
 *   SET balance    = balance + p_amount,
 *       updated_at = now()
 *   WHERE user_id = p_user_id AND vault_type = p_vault_type
 *   RETURNING * INTO v_wallet;
 *   IF NOT FOUND THEN
 *     RAISE EXCEPTION 'Wallet not found for user % vault %', p_user_id, p_vault_type;
 *   END IF;
 *   RETURN v_wallet;
 * END; $$;
 * ──────────────────────────────────────────────────────────────
 */
export async function creditWallet(userId, amount, vaultType = 'client') {
  const { data, error } = await supabaseAdmin
    .rpc('credit_wallet_topup', {
      p_user_id:    userId,
      p_amount:     amount,
      p_vault_type: vaultType,
    });

  if (error) throw new Error(`Wallet credit failed: ${error.message}`);
  if (!data) throw new NotFoundError(`Wallet (${vaultType})`);
  return data;
}

/**
 * Reserve funds atomically via DB function.
 *
 * NOTE: Postgres function `reserve_wallet_funds` must accept `p_vault_type`.
 * ── SQL MIGRATION ─────────────────────────────────────────────
 * CREATE OR REPLACE FUNCTION reserve_wallet_funds(
 *   p_user_id UUID,
 *   p_amount  NUMERIC,
 *   p_vault_type TEXT DEFAULT 'client'
 * ) RETURNS JSONB LANGUAGE plpgsql AS $$
 * DECLARE
 *   v_wallet wallets;
 *   v_available NUMERIC;
 * BEGIN
 *   SELECT * INTO v_wallet
 *   FROM wallets
 *   WHERE user_id = p_user_id AND vault_type = p_vault_type
 *   FOR UPDATE;
 *
 *   IF NOT FOUND THEN
 *     RETURN jsonb_build_object('success', false, 'reason', 'wallet_not_found');
 *   END IF;
 *
 *   v_available := v_wallet.balance - v_wallet.reserved_balance;
 *   IF v_available < p_amount THEN
 *     RETURN jsonb_build_object('success', false, 'reason', 'insufficient_funds');
 *   END IF;
 *
 *   UPDATE wallets
 *   SET reserved_balance = reserved_balance + p_amount
 *   WHERE user_id = p_user_id AND vault_type = p_vault_type;
 *
 *   RETURN jsonb_build_object('success', true);
 * END; $$;
 * ──────────────────────────────────────────────────────────────
 */
export async function reserveFunds(userId, amount, vaultType = 'client') {
  const { data, error } = await supabaseAdmin
    .rpc('reserve_wallet_funds', {
      p_user_id:    userId,
      p_amount:     amount,
      p_vault_type: vaultType,
    });

  if (error) throw new Error(`Reserve RPC failed: ${error.message}`);
  return data;
}

/**
 * Release reservation via DB function.
 *
 * NOTE: Postgres function `release_wallet_reservation` must accept `p_vault_type`.
 * ── SQL MIGRATION ─────────────────────────────────────────────
 * CREATE OR REPLACE FUNCTION release_wallet_reservation(
 *   p_user_id UUID,
 *   p_amount  NUMERIC,
 *   p_vault_type TEXT DEFAULT 'client'
 * ) RETURNS void LANGUAGE plpgsql AS $$
 * BEGIN
 *   UPDATE wallets
 *   SET reserved_balance = GREATEST(0, reserved_balance - p_amount)
 *   WHERE user_id = p_user_id AND vault_type = p_vault_type;
 * END; $$;
 * ──────────────────────────────────────────────────────────────
 */
export async function releaseReservation(userId, amount, vaultType = 'client') {
  const { error } = await supabaseAdmin
    .rpc('release_wallet_reservation', {
      p_user_id:    userId,
      p_amount:     amount,
      p_vault_type: vaultType,
    });

  if (error) throw new Error(`Release RPC failed: ${error.message}`);
}

/**
 * Atomic deduction via DB function (with SELECT FOR UPDATE).
 *
 * NOTE: Postgres function `deduct_wallet_for_session` must accept `p_vault_type`.
 * ── SQL MIGRATION ─────────────────────────────────────────────
 * CREATE OR REPLACE FUNCTION deduct_wallet_for_session(
 *   p_user_id     UUID,
 *   p_session_id  UUID,
 *   p_amount      NUMERIC,
 *   p_description TEXT,
 *   p_vault_type  TEXT DEFAULT 'client'
 * ) RETURNS JSONB LANGUAGE plpgsql AS $$
 * DECLARE
 *   v_wallet wallets;
 * BEGIN
 *   SELECT * INTO v_wallet
 *   FROM wallets
 *   WHERE user_id = p_user_id AND vault_type = p_vault_type
 *   FOR UPDATE;
 *
 *   IF NOT FOUND THEN
 *     RETURN jsonb_build_object('success', false, 'reason', 'wallet_not_found');
 *   END IF;
 *
 *   IF v_wallet.balance < p_amount THEN
 *     RETURN jsonb_build_object('success', false, 'reason', 'insufficient_funds');
 *   END IF;
 *
 *   UPDATE wallets
 *   SET balance = balance - p_amount
 *   WHERE user_id = p_user_id AND vault_type = p_vault_type;
 *
 *   RETURN jsonb_build_object('success', true);
 * END; $$;
 * ──────────────────────────────────────────────────────────────
 */
export async function deductWallet(userId, sessionId, amount, description, vaultType = 'client') {
  const { data, error } = await supabaseAdmin
    .rpc('deduct_wallet_for_session', {
      p_user_id:     userId,
      p_session_id:  sessionId,
      p_amount:      amount,
      p_description: description,
      p_vault_type:  vaultType,
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