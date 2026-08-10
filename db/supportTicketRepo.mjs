import { supabaseAdmin } from '../config/supabase.mjs';
import { eventBus, EVENTS } from '../utils/eventBus.mjs';
import { logger } from '../config/logger.mjs';

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
 * List support tickets for the admin dashboard.
 *
 * FIX: previously used PostgREST's relationship-embed syntax
 * (.select('..., users(full_name, email)')), which depends on Supabase
 * being able to resolve a foreign key from support_tickets to a table
 * literally reachable as "users" in the schema. The original migration
 * pointed that FK at auth.users instead of public.users — a mismatch with
 * every other table in this app — so the embed silently failed, the error
 * was caught, and the admin page always showed zero tickets even though
 * creation and the real-time push were both working. A migration fixes
 * the FK itself (see migrations/20260810_fix_support_tickets_user_fk.sql),
 * but this also stops depending on the embed relationship entirely: fetch
 * tickets first, then batch-resolve names/emails with a plain .in() query
 * against 'users' directly (same table getUserById() in db/userRepo.mjs
 * already uses successfully elsewhere). One extra query per page load,
 * but it can't break the same way again regardless of FK schema changes.
 */
export async function getSupportTickets({ status } = {}) {
  let query = supabaseAdmin
    .from('support_tickets')
    .select('id, user_id, role, subject, message, status, created_at, resolved_at')
    .order('created_at', { ascending: false })
    .limit(100);

  if (status && status !== 'all') query = query.eq('status', status);

  const { data: tickets, error } = await query;
  if (error) throw new Error(`getSupportTickets failed: ${error.message}`);
  if (!tickets || tickets.length === 0) return [];

  const userIds = [...new Set(tickets.map(t => t.user_id).filter(Boolean))];
  const { data: users, error: usersError } = await supabaseAdmin
    .from('users')
    .select('id, full_name, email')
    .in('id', userIds);

  if (usersError) {
    // Don't fail the whole ticket list just because name/email lookup
    // failed — an admin seeing "Unknown" is far better than seeing
    // nothing at all, which is exactly the bug this rewrite exists to fix.
    logger.error({ error: usersError }, 'getSupportTickets: user lookup failed, showing tickets without names');
  }
  const userById = new Map((users || []).map(u => [u.id, u]));

  return tickets.map(t => ({
    id:         t.id,
    userId:     t.user_id,
    role:       t.role,
    subject:    t.subject,
    message:    t.message,
    status:     t.status,
    createdAt:  t.created_at,
    resolvedAt: t.resolved_at,
    userName:   userById.get(t.user_id)?.full_name ?? 'Unknown',
    userEmail:  userById.get(t.user_id)?.email ?? null,
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
