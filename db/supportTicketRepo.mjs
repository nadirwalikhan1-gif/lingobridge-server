import { supabaseAdmin } from '../config/supabase.mjs';
import { eventBus, EVENTS } from '../utils/eventBus.mjs';
import { logger } from '../config/logger.mjs';

/**
 * Create a support ticket. ticket_number is assigned automatically by the
 * database (support_ticket_number_seq — see
 * migrations/20260817_support_ticket_number.sql), not generated here.
 */
export async function createSupportTicket({ userId, role, subject, message }) {
  const { data, error } = await supabaseAdmin
    .from('support_tickets')
    .insert({ user_id: userId, role, subject, message })
    .select()
    .single();

  if (error) throw new Error(`Support ticket creation failed: ${error.message}`);

  // Real-time push to the admin dashboard — decouples every creation path
  // (contact form, account deletion, BAA request, review report) from
  // needing its own notification logic. socket/index.mjs listens for this.
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
 * List support tickets for the admin dashboard.
 *
 * Deliberately does NOT use PostgREST's relationship-embed syntax
 * (.select('..., users(...)')) — that depends on Supabase resolving a
 * foreign key to a table literally reachable as "users", and got this
 * exact feature wrong once already (the original migration pointed
 * support_tickets.user_id at auth.users instead of public.users, silently
 * breaking the embed with no visible error). Fetches tickets first, then
 * batch-resolves full contact/profile info with a plain .in() query
 * against 'users' directly — the same table getUserById() in
 * db/userRepo.mjs already uses successfully elsewhere — so this can't
 * break the same way again regardless of how the schema evolves.
 *
 * organization/jobTitle live inside users.profile_extra (JSONB), not as
 * their own columns — confirmed against routes/v1.mjs's GET /users/me/profile.
 */
export async function getSupportTickets({ status } = {}) {
  let query = supabaseAdmin
    .from('support_tickets')
    .select('id, ticket_number, user_id, role, subject, message, status, created_at, resolved_at')
    .order('created_at', { ascending: false })
    .limit(100);

  if (status && status !== 'all') query = query.eq('status', status);

  const { data: tickets, error } = await query;
  if (error) throw new Error(`getSupportTickets failed: ${error.message}`);
  if (!tickets || tickets.length === 0) return [];

  const userIds = [...new Set(tickets.map(t => t.user_id).filter(Boolean))];
  const { data: users, error: usersError } = await supabaseAdmin
    .from('users')
    .select('id, full_name, email, phone, profile_extra')
    .in('id', userIds);

  if (usersError) {
    // Don't fail the whole ticket list just because profile lookup
    // failed — an admin seeing "Unknown" is far better than seeing
    // nothing at all.
    logger.error({ error: usersError }, 'getSupportTickets: user lookup failed, showing tickets without profile info');
  }
  const userById = new Map((users || []).map(u => [u.id, u]));

  return tickets.map(t => {
    const user = userById.get(t.user_id);
    const extra = user?.profile_extra ?? {};
    return {
      id:           t.id,
      // FIX: formatted as a plain numeric string ('100000') — always
      // numeric-only text, matching what an admin will actually type or
      // read back to a client over the phone.
      ticketNumber: String(t.ticket_number),
      userId:       t.user_id,
      role:         t.role,
      subject:      t.subject,
      message:      t.message,
      status:       t.status,
      createdAt:    t.created_at,
      resolvedAt:   t.resolved_at,
      userName:     user?.full_name ?? 'Unknown',
      userEmail:    user?.email ?? null,
      userPhone:    user?.phone ?? null,
      organization: extra.organization ?? null,
      jobTitle:     extra.jobTitle ?? null,
    };
  });
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
