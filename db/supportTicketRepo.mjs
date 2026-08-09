import { supabaseAdmin } from '../config/supabase.mjs';
import { eventBus, EVENTS } from '../utils/eventBus.mjs';

/**
 * Create a support ticket.
 */
export async function createSupportTicket({ userId, role, subject, message }) {
  const { data, error } = await supabaseAdmin
    .from('support_tickets')
    .insert({ user_id: userId, role, subject, message })
    .select()
    .single();

  if (error) throw new Error(`Support ticket creation failed: ${error.message}`);

  // FIX: this is the piece that was actually missing for "any option on
  // the client dashboard meant to reach admin should work" — the ticket
  // was always written correctly (once the table existed), but nothing
  // told the admin dashboard a new one had arrived. Emitting here, in the
  // one shared function every creation path already calls through
  // (contact form, account deletion, BAA request, review report), means
  // all of them light up the admin dashboard in real time for free —
  // socket/index.mjs listens for this and pushes to the admins room.
  eventBus.emit(EVENTS.SUPPORT_TICKET_CREATED, data);

  return data;
}

/**
 * Get a user's own support tickets (for their "my tickets" view, if ever added).
 */
export async function getSupportTicketsByUser(userId, limit = 20, offset = 0) {
  const { data, error } = await supabaseAdmin
    .from('support_tickets')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(`Support tickets fetch failed: ${error.message}`);
  return data || [];
}

/**
 * List support tickets for the admin dashboard. Mirrors
 * getActiveDisputes()'s shape in socket/handlers/adminHandler.mjs — same
 * project, same convention, so both admin queue pages behave consistently.
 */
export async function getSupportTickets({ status } = {}) {
  let query = supabaseAdmin
    .from('support_tickets')
    .select('id, user_id, role, subject, message, status, created_at, resolved_at, users(full_name, email)')
    .order('created_at', { ascending: false })
    .limit(100);

  if (status && status !== 'all') query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw new Error(`getSupportTickets failed: ${error.message}`);

  return (data || []).map(t => ({
    id:         t.id,
    userId:     t.user_id,
    role:       t.role,
    subject:    t.subject,
    message:    t.message,
    status:     t.status,
    createdAt:  t.created_at,
    resolvedAt: t.resolved_at,
    userName:   t.users?.full_name ?? 'Unknown',
    userEmail:  t.users?.email ?? null,
  }));
}

/**
 * Update ticket status — used by the admin resolve/reopen actions.
 */
export async function updateSupportTicketStatus(id, status) {
  const { data, error } = await supabaseAdmin
    .from('support_tickets')
    .update({ status, resolved_at: status === 'resolved' ? new Date().toISOString() : null })
    .eq('id', id)
    .select()
    .single();

  if (error) throw new Error(`updateSupportTicketStatus failed: ${error.message}`);
  return data;
}
