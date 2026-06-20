import { supabaseAdmin } from '../config/supabase.mjs';

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
