import { supabaseAdmin } from '../config/supabase.mjs';
import { NotFoundError } from '../utils/errors.mjs';

/**
 * Get interpreter profile by user ID
 */
export async function getInterpreterByUserId(userId) {
  const { data, error } = await supabaseAdmin
    .from('interpreters')
    .select('*, users(full_name, email, avatar_url, currency)')
    .eq('user_id', userId)
    .single();

  if (error || !data) throw new NotFoundError('Interpreter');
  return data;
}

/**
 * Get all available interpreters
 */
export async function getAvailableInterpreters() {
  const { data, error } = await supabaseAdmin
    .from('interpreters')
    .select('*, users(full_name, avatar_url)')
    .eq('is_available', true)
    .eq('is_verified', true)
    .order('rating', { ascending: false });

  if (error) throw new Error(`Interpreters fetch failed: ${error.message}`);
  return data || [];
}

/**
 * Get available interpreters by language
 */
export async function getAvailableInterpretersByLanguage(language) {
  const { data, error } = await supabaseAdmin
    .from('interpreters')
    .select('*, users(full_name, avatar_url)')
    .eq('is_available', true)
    .eq('is_verified', true)
    .contains('languages', [language])
    .order('rating', { ascending: false });

  if (error) throw new Error(`Interpreters by language failed: ${error.message}`);
  return data || [];
}

/**
 * Set interpreter availability
 */
export async function setInterpreterAvailability(userId, isAvailable) {
  const { error } = await supabaseAdmin
    .from('interpreters')
    .update({ is_available: isAvailable })
    .eq('user_id', userId);

  if (error) throw new Error(`Availability update failed: ${error.message}`);
}

/**
 * Update interpreter rating (after session rating submitted)
 */
export async function updateInterpreterRating(userId) {
  const { data: sessions } = await supabaseAdmin
    .from('session_ratings')
    .select('rating, sessions!inner(interpreter_id)')
    .eq('sessions.interpreter_id', userId);

  if (!sessions?.length) return;

  const avg = sessions.reduce((sum, s) => sum + s.rating, 0) / sessions.length;

  await supabaseAdmin
    .from('interpreters')
    .update({ rating: parseFloat(avg.toFixed(2)) })
    .eq('user_id', userId);
}

/**
 * Get interpreter payout history
 * FIX: vault-model — now reads from payout_requests table
 */
export async function getPayoutsByInterpreter(interpreterId) {
  const { data, error } = await supabaseAdmin
    .from('payout_requests') // FIX: vault-model table name
    .select('*')
    .eq('interpreter_id', interpreterId)
    .order('requested_at', { ascending: false }); // FIX: column name

  if (error) throw new Error(`Payouts fetch failed: ${error.message}`);
  return data || [];
}

/**
 * FIX: vault-model — get interpreter vault balance for dashboard
 */
export async function getInterpreterBalance(userId) {
  const { data, error } = await supabaseAdmin
    .from('wallets')
    .select('balance, reserved_balance, currency')
    .eq('user_id', userId)
    .eq('vault_type', 'interpreter')
    .single();

  if (error || !data) throw new NotFoundError('Interpreter wallet');
  return {
    balance: data.balance,
    reservedBalance: data.reserved_balance,
    availableBalance: data.balance - data.reserved_balance,
    currency: data.currency,
  };
}
/**
 * Get interpreter dashboard settings (notification prefs etc).
 */
export async function getInterpreterSettings(userId) {
  const { data, error } = await supabaseAdmin
    .from('interpreters')
    .select('settings')
    .eq('user_id', userId)
    .single();

  if (error || !data) throw new NotFoundError('Interpreter');
  return data.settings;
}

/**
 * Update interpreter dashboard settings. Merges into existing settings jsonb
 * rather than overwriting, so a partial update can't wipe out other keys.
 */
export async function updateInterpreterSettings(userId, updates) {
  const current = await getInterpreterSettings(userId);
  const merged = { ...current, ...updates };

  const { data, error } = await supabaseAdmin
    .from('interpreters')
    .update({ settings: merged })
    .eq('user_id', userId)
    .select('settings')
    .single();

  if (error) throw new Error(`Settings update failed: ${error.message}`);
  return data.settings;
}

/**
 * Update interpreter-owned profile fields (bio, languages). Name/email/avatar
 * live on the `users` table and go through updateUser() in userRepo.mjs instead.
 */
export async function updateInterpreterProfile(userId, updates) {
  const allowed = ['bio', 'languages'];
  const sanitized = Object.fromEntries(
    Object.entries(updates).filter(([k]) => allowed.includes(k))
  );

  if (Object.keys(sanitized).length === 0) {
    return getInterpreterByUserId(userId);
  }

  const { error } = await supabaseAdmin
    .from('interpreters')
    .update(sanitized)
    .eq('user_id', userId);

  if (error) throw new Error(`Interpreter profile update failed: ${error.message}`);
  return getInterpreterByUserId(userId);
}

/**
 * Set interpreter status (online / offline).
 * Keeps is_available in sync for backward compatibility with existing
 * matching/request-routing logic, which only ever checks is_available.
 *
 * FIX: was documented as three-state (online/break/offline), but 'break'
 * was never actually reachable from the current UI (see
 * statusConfig.js — Dashboard.jsx / Availability.jsx only ever emit
 * go-online/go-offline) and the socket handler that set it has been
 * removed (see registerHandler.mjs). See
 * migrations/20260709_remove_break_status.sql for the matching backfill
 * and CHECK constraint tightening.
 */
export async function setInterpreterStatus(userId, status) {
  if (!['online', 'offline'].includes(status)) {
    throw new Error(`Invalid interpreter status: ${status}`);
  }

  const { data, error } = await supabaseAdmin
    .from('interpreters')
    .update({
      status,
      is_available: status === 'online',
    })
    .eq('user_id', userId)
    .select('status, is_available')
    .single();

  if (error) throw new Error(`Status update failed: ${error.message}`);
  return data;
}

/**
 * Rating summary + trend for an interpreter (uses the interpreter_reviews
 * view — see migrations/ — which already filters out self-ratings).
 */
export async function getInterpreterRatingSummary(userId) {
  const interpreter = await getInterpreterByUserId(userId);

  const { data, error } = await supabaseAdmin
    .from('interpreter_reviews')
    .select('rating, created_at')
    .eq('interpreter_id', interpreter.id)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Rating summary failed: ${error.message}`);

  const reviews = data || [];
  const totalReviews = reviews.length;
  const average = totalReviews > 0
    ? reviews.reduce((sum, r) => sum + r.rating, 0) / totalReviews
    : interpreter.rating;

  // Trend: average of most recent 10 vs the 10 before that
  const recent = reviews.slice(0, 10);
  const previous = reviews.slice(10, 20);
  const recentAvg = recent.length > 0
    ? recent.reduce((s, r) => s + r.rating, 0) / recent.length
    : null;
  const previousAvg = previous.length > 0
    ? previous.reduce((s, r) => s + r.rating, 0) / previous.length
    : null;

  return {
    currentRating: interpreter.rating,
    averageFromReviews: parseFloat(average.toFixed(2)),
    totalReviews,
    trend: (recentAvg !== null && previousAvg !== null) ? parseFloat((recentAvg - previousAvg).toFixed(2)) : null,
  };
}

/**
 * List reviews for an interpreter (paginated).
 */
export async function getInterpreterReviews(userId, limit = 20, offset = 0) {
  const interpreter = await getInterpreterByUserId(userId);

  const { data, error } = await supabaseAdmin
    .from('interpreter_reviews')
    .select('*')
    .eq('interpreter_id', interpreter.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(`Reviews fetch failed: ${error.message}`);
  return data || [];
}
