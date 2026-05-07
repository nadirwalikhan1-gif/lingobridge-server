import { supabaseAdmin } from '../config/supabase.mjs';
import { NotFoundError } from '../utils/errors.mjs';
import { logger } from '../config/logger.mjs';

/**
 * Get user profile by ID
 */
export async function getUserById(userId) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('id', userId)
    .single();

  if (error || !data) throw new NotFoundError('User');
  return data;
}

/**
 * Get user with wallet in one query
 */
export async function getUserWithWallet(userId) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('*, wallets(*)')
    .eq('id', userId)
    .single();

  if (error || !data) throw new NotFoundError('User');
  return data;
}

/**
 * Update user profile
 */
export async function updateUser(userId, updates) {
  const allowed = ['full_name', 'country', 'currency', 'avatar_url'];
  const sanitized = Object.fromEntries(
    Object.entries(updates).filter(([k]) => allowed.includes(k))
  );

  const { data, error } = await supabaseAdmin
    .from('users')
    .update(sanitized)
    .eq('id', userId)
    .select()
    .single();

  if (error) throw new Error(`User update failed: ${error.message}`);
  return data;
}

/**
 * Get user currency preference
 */
export async function getUserCurrency(userId) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('currency')
    .eq('id', userId)
    .single();

  if (error || !data) return 'USD';
  return data.currency || 'USD';
}

/**
 * Check if user exists
 */
export async function userExists(userId) {
  const { data } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('id', userId)
    .single();

  return !!data;
}

/**
 * Create user profile (called from Supabase trigger fallback)
 */
export async function createUser({ id, email, fullName, currency = 'USD' }) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .insert({ id, email, full_name: fullName, currency })
    .select()
    .single();

  if (error) throw new Error(`User create failed: ${error.message}`);

  // Create wallet
  await supabaseAdmin
    .from('wallets')
    .insert({ user_id: id, balance: 0.00, currency })
    .catch((e) => logger.error({ e }, 'Wallet creation failed'));

  return data;
}
