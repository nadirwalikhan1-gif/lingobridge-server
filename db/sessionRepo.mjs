import { supabaseAdmin } from '../config/supabase.mjs';
import { NotFoundError } from '../utils/errors.mjs';

/**
 * Create a new session
 */
export async function createSession(data) {
  const { data: session, error } = await supabaseAdmin
    .from('sessions')
    .insert({
      client_id:     data.clientId,
      language:      data.language,
      purpose:       data.purpose,
      session_type:  data.sessionType,
      currency:      data.currency,
      agora_channel: data.agoraChannel,
      status:        'pending',
    })
    .select()
    .single();

  if (error) throw new Error(`Session create failed: ${error.message}`);
  return session;
}

/**
 * Get session by ID
 */
export async function getSessionById(sessionId) {
  const { data, error } = await supabaseAdmin
    .from('sessions')
    .select('*')
    .eq('id', sessionId)
    .single();

  if (error || !data) throw new NotFoundError('Session');
  return data;
}

/**
 * Get active session by Agora channel name
 */
export async function getActiveSessionByChannel(channelName) {
  const { data } = await supabaseAdmin
    .from('sessions')
    .select('*')
    .eq('agora_channel', channelName)
    .eq('status', 'active')
    .single();

  return data || null;
}

/**
 * Update session status
 */
export async function updateSessionStatus(sessionId, status, extra = {}) {
  const { data, error } = await supabaseAdmin
    .from('sessions')
    .update({ status, ...extra })
    .eq('id', sessionId)
    .select()
    .single();

  if (error) throw new Error(`Session update failed: ${error.message}`);
  return data;
}

/**
 * Mark session as active (called when interpreter accepts)
 */
export async function activateSession(sessionId, interpreterId) {
  return updateSessionStatus(sessionId, 'active', {
    interpreter_id: interpreterId,
    started_at:     new Date().toISOString(),
    last_billed_at: new Date().toISOString(),
  });
}

/**
 * Update last_billed_at (heartbeat for billing engine)
 */
export async function updateLastBilledAt(sessionId) {
  await supabaseAdmin
    .from('sessions')
    .update({ last_billed_at: new Date().toISOString() })
    .eq('id', sessionId);
}

/**
 * Get all stale active sessions
 */
export async function getStaleSessions(thresholdHours = 3) {
  const cutoff = new Date(Date.now() - thresholdHours * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabaseAdmin
    .from('sessions')
    .select('*')
    .eq('status', 'active')
    .lt('started_at', cutoff);

  if (error) throw new Error(`Stale sessions fetch failed: ${error.message}`);
  return data || [];
}

/**
 * Get sessions for a user (client history)
 */
export async function getSessionsByUser(userId, limit = 20, offset = 0) {
  const { data, error } = await supabaseAdmin
    .from('sessions')
    .select('*')
    .eq('client_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(`Session history failed: ${error.message}`);
  return data || [];
}

/**
 * Get pending sessions (no interpreter yet)
 */
export async function getPendingSessions() {
  const { data, error } = await supabaseAdmin
    .from('sessions')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Pending sessions fetch failed: ${error.message}`);
  return data || [];
}
