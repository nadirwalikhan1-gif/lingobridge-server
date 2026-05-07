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
  // Recalculate average from all ratings
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
 */
export async function getPayoutsByInterpreter(interpreterId) {
  const { data, error } = await supabaseAdmin
    .from('interpreter_payouts')
    .select('*')
    .eq('interpreter_id', interpreterId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Payouts fetch failed: ${error.message}`);
  return data || [];
}
