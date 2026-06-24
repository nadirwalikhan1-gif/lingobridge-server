import { supabaseAdmin } from '../config/supabase.mjs';
import { NotFoundError } from '../utils/errors.mjs';

/**
 * Create a new session.
 */
export async function createSession(data) {
  const { data: session, error } = await supabaseAdmin
    .from('sessions')
    .insert({
      client_id:          data.clientId,
      language:           data.language,
      purpose:            data.purpose,
      session_type:       data.sessionType,
      currency:           data.currency,
      agora_channel:      data.agoraChannel,
      booked_duration:    data.bookedDuration || (parseInt(data.duration) * 60) || 1800,
      status:             'pending',
      // Hold state — initialised false, updated by socket hold-session events
      on_hold:            false,
      hold_started_at:    null,
      total_hold_seconds: 0,
    })
    .select()
    .single();

  if (error) throw new Error(`Session create failed: ${error.message}`);
  return session;
}

/**
 * Get session by ID.
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
 * Get active session by Agora channel name.
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
 * Update session status with optional extra fields.
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
 * Mark session as active (called when interpreter accepts).
 */
export async function activateSession(sessionId, interpreterId) {
  return updateSessionStatus(sessionId, 'active', {
    interpreter_id: interpreterId,
    started_at:     new Date().toISOString(),
    last_billed_at: new Date().toISOString(),
  });
}

/**
 * Update last_billed_at (legacy heartbeat).
 */
export async function updateLastBilledAt(sessionId) {
  await supabaseAdmin
    .from('sessions')
    .update({ last_billed_at: new Date().toISOString() })
    .eq('id', sessionId);
}

/**
 * Get all active sessions that are NOT on hold.
 * Used by the active billing tick.
 */
export async function getActiveBillableSessions() {
  const { data, error } = await supabaseAdmin
    .from('sessions')
    .select('id, client_id, interpreter_id, session_type, currency, started_at')
    .eq('status', 'active')
    .eq('on_hold', false);

  if (error) throw new Error(`Active sessions fetch failed: ${error.message}`);
  return data || [];
}

/**
 * Get all active sessions that ARE on hold.
 * Used by the hold billing tick.
 */
export async function getHeldSessions() {
  const { data, error } = await supabaseAdmin
    .from('sessions')
    .select('id, client_id, interpreter_id, session_type, currency, total_hold_seconds, hold_started_at')
    .eq('status', 'active')
    .eq('on_hold', true)
    .not('hold_started_at', 'is', null);

  if (error) throw new Error(`Held sessions fetch failed: ${error.message}`);
  return data || [];
}

/**
 * Put a session on hold — record who triggered it and when.
 */
export async function setSessionOnHold(channelName) {
  const { error } = await supabaseAdmin
    .from('sessions')
    .update({
      on_hold:         true,
      hold_started_at: new Date().toISOString(),
    })
    .eq('agora_channel', channelName)
    .eq('status', 'active');

  if (error) throw new Error(`Hold set failed: ${error.message}`);
}

/**
 * Resume a held session — accumulate hold seconds, clear the hold timestamp.
 */
export async function resumeSessionFromHold(channelName) {
  // First fetch the current hold_started_at so we can compute elapsed seconds
  const { data: session, error: fetchErr } = await supabaseAdmin
    .from('sessions')
    .select('id, hold_started_at, total_hold_seconds')
    .eq('agora_channel', channelName)
    .eq('status', 'active')
    .single();

  if (fetchErr || !session) throw new Error('Session not found for resume');

  const holdStarted = new Date(session.hold_started_at);
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - holdStarted.getTime()) / 1000)
  );
  const newTotal = (session.total_hold_seconds || 0) + elapsedSeconds;

  const { error: updateErr } = await supabaseAdmin
    .from('sessions')
    .update({
      on_hold:            false,
      hold_started_at:    null,
      total_hold_seconds: newTotal,
    })
    .eq('id', session.id);

  if (updateErr) throw new Error(`Hold resume failed: ${updateErr.message}`);
  return { elapsedSeconds, totalHoldSeconds: newTotal };
}

/**
 * Increment total_hold_seconds by tickSeconds (called by holdBillingTick).
 */
export async function incrementHoldSeconds(sessionId, tickSeconds) {
  const { error } = await supabaseAdmin.rpc('increment_hold_seconds', {
    p_session_id:  sessionId,
    p_tick_seconds: tickSeconds,
  });

  // Fallback if RPC not yet created — direct update
  if (error) {
    const { data: current } = await supabaseAdmin
      .from('sessions')
      .select('total_hold_seconds')
      .eq('id', sessionId)
      .single();

    await supabaseAdmin
      .from('sessions')
      .update({ total_hold_seconds: (current?.total_hold_seconds || 0) + tickSeconds })
      .eq('id', sessionId);
  }
}

/**
 * Extend booked_duration by additionalSeconds.
 */
export async function extendSessionDuration(sessionId, additionalSeconds) {
  const { data: current } = await supabaseAdmin
    .from('sessions')
    .select('booked_duration')
    .eq('id', sessionId)
    .single();

  const newDuration = (current?.booked_duration || 0) + additionalSeconds;

  const { data, error } = await supabaseAdmin
    .from('sessions')
    .update({ booked_duration: newDuration })
    .eq('id', sessionId)
    .select('booked_duration')
    .single();

  if (error) throw new Error(`Extend session failed: ${error.message}`);
  return data;
}

/**
 * Mark a session as ended due to insufficient client funds.
 */
export async function endSessionInsufficientFunds(sessionId) {
  await supabaseAdmin
    .from('sessions')
    .update({
      status:   'ended_insufficient_funds',
      ended_at: new Date().toISOString(),
      on_hold:  false,
    })
    .eq('id', sessionId);
}

/**
 * Mark session as completed.
 */
export async function completeSession(sessionId) {
  const { data, error } = await supabaseAdmin
    .from('sessions')
    .update({
      status:   'completed',
      ended_at: new Date().toISOString(),
      on_hold:  false,
    })
    .eq('id', sessionId)
    .eq('status', 'active')
    .select()
    .single();

  if (error) throw new Error(`Complete session failed: ${error.message}`);
  return data;
}

/**
 * Get all stale active sessions.
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
 * Get sessions for a user (client history).
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
 * Get pending sessions (no interpreter yet).
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

/**
 * Get session history for an interpreter (mirrors getSessionsByUser, but
 * filtered by interpreter_id instead of client_id — added rather than
 * modifying getSessionsByUser since that function is already used by the
 * client-facing session history page).
 */
export async function getSessionsByInterpreter(interpreterId, limit = 20, offset = 0) {
  const { data, error } = await supabaseAdmin
    .from('sessions')
    .select('*')
    .eq('interpreter_id', interpreterId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(`Interpreter session history failed: ${error.message}`);
  return data || [];
}

/**
 * Get completed session count + total minutes for an interpreter within a
 * date range (used for dashboard stats and earnings chart bucketing).
 */
export async function getInterpreterSessionStats(interpreterId, sinceISO = null) {
  let query = supabaseAdmin
    .from('sessions')
    .select('id, duration_minutes, session_type, language, status, ended_at, created_at')
    .eq('interpreter_id', interpreterId)
    .eq('status', 'completed');

  if (sinceISO) query = query.gte('ended_at', sinceISO);

  const { data, error } = await query;
  if (error) throw new Error(`Interpreter session stats failed: ${error.message}`);
  return data || [];
}
