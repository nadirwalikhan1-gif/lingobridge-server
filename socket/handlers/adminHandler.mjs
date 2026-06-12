// socket/handlers/adminHandler.mjs
// Handles all admin dashboard socket events

import { supabaseAdmin } from '../../config/supabase.mjs';
import { logger } from '../../config/logger.mjs';
import { getPendingRooms } from '../runtime/sessionRuntime.mjs';

async function getPlatformStats() {
  const [activeSessions, interpretersOnline, openDisputes] = await Promise.all([
    supabaseAdmin.from('sessions').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabaseAdmin.from('interpreters').select('id', { count: 'exact', head: true }).eq('is_available', true),
    supabaseAdmin.from('disputes').select('id', { count: 'exact', head: true }).eq('status', 'open'),
  ]);

  return {
    activeSessions:      activeSessions.count  ?? 0,
    interpretersOnline:  interpretersOnline.count ?? 0,
    openDisputes:        openDisputes.count    ?? 0,
  };
}

async function getLiveSessions() {
  const { data, error } = await supabaseAdmin
    .from('sessions')
    .select('id, agora_channel, language, session_type, started_at, client_id, interpreter_id, users!sessions_client_id_fkey(full_name)')
    .eq('status', 'active')
    .order('started_at', { ascending: false })
    .limit(20);

  if (error) { logger.error({ error }, 'getLiveSessions failed'); return []; }
  return (data || []).map(s => ({
    id:          s.id,
    channel:     s.agora_channel,
    language:    s.language,
    type:        s.session_type,
    startedAt:   s.started_at,
    clientName:  s.users?.full_name ?? 'Unknown',
    clientId:    s.client_id,
    interpreterId: s.interpreter_id,
  }));
}

async function getRequestQueue() {
  const pending = getPendingRooms();
  return pending.map(r => ({
    id:        r.requestId ?? r.id,
    language:  r.language,
    purpose:   r.purpose,
    type:      r.sessionType ?? r.type,
    clientId:  r.clientId,
    createdAt: r.createdAt ?? new Date().toISOString(),
  }));
}

async function getInterpreterPresence() {
  const { data, error } = await supabaseAdmin
    .from('interpreters')
    .select('user_id, is_available, languages, rating, users(full_name, avatar_url)')
    .order('is_available', { ascending: false })
    .limit(30);

  if (error) { logger.error({ error }, 'getInterpreterPresence failed'); return []; }
  return (data || []).map(i => ({
    id:          i.user_id,
    name:        i.users?.full_name ?? 'Unknown',
    avatar:      i.users?.avatar_url ?? null,
    isAvailable: i.is_available,
    languages:   i.languages ?? [],
    rating:      i.rating ?? 0,
  }));
}

async function getActiveDisputes() {
  const { data, error } = await supabaseAdmin
    .from('disputes')
    .select('id, session_id, reason, status, created_at, raised_by, users!disputes_raised_by_fkey(full_name)')
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) { logger.error({ error }, 'getActiveDisputes failed'); return []; }
  return (data || []).map(d => ({
    id:        d.id,
    sessionId: d.session_id,
    reason:    d.reason,
    status:    d.status,
    raisedBy:  d.users?.full_name ?? 'Unknown',
    createdAt: d.created_at,
  }));
}

async function getPayoutQueue() {
  const { data, error } = await supabaseAdmin
    .from('payout_requests')
    .select('id, interpreter_id, amount, currency, status, requested_at, users!payout_requests_interpreter_id_fkey(full_name)')
    .eq('status', 'pending')
    .order('requested_at', { ascending: true })
    .limit(20);

  if (error) { logger.error({ error }, 'getPayoutQueue failed'); return []; }
  return (data || []).map(p => ({
    id:             p.id,
    interpreterId:  p.interpreter_id,
    interpreterName: p.users?.full_name ?? 'Unknown',
    amount:         p.amount,
    currency:       p.currency,
    requestedAt:    p.requested_at,
  }));
}

async function getAlerts() {
  // Return recent disputes and stale sessions as alerts
  const { data: disputes } = await supabaseAdmin
    .from('disputes')
    .select('id, reason, created_at')
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(5);

  return (disputes || []).map(d => ({
    id:      d.id,
    type:    'dispute',
    message: `Open dispute: ${d.reason ?? 'No reason given'}`,
    time:    d.created_at,
  }));
}

async function getSystemHealth() {
  const { data: sessions } = await supabaseAdmin
    .from('sessions')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'active');

  return [
    { label: 'Database',    status: 'ok' },
    { label: 'Socket',      status: 'ok' },
    { label: 'Active calls', status: 'ok', value: sessions?.count ?? 0 },
  ];
}

async function getSnapshot() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [todaySessions, todayRevenue, totalUsers] = await Promise.all([
    supabaseAdmin.from('sessions').select('id', { count: 'exact', head: true }).gte('created_at', today.toISOString()),
    supabaseAdmin.from('transactions').select('amount').eq('type', 'charge').gte('created_at', today.toISOString()),
    supabaseAdmin.from('users').select('id', { count: 'exact', head: true }),
  ]);

  const revenue = (todayRevenue.data || []).reduce((sum, t) => sum + (t.amount || 0), 0);

  return {
    todaySessions: todaySessions.count ?? 0,
    todayRevenue:  parseFloat(revenue.toFixed(2)),
    totalUsers:    totalUsers.count ?? 0,
  };
}

export function registerAdminHandlers(io, socket) {
  if (socket.role !== 'admin') return;

  socket.on('get-platform-stats',      async () => { try { socket.emit('platform-stats',      await getPlatformStats());      } catch (e) { logger.error(e, 'platform-stats error'); } });
  socket.on('get-live-sessions',       async () => { try { socket.emit('live-sessions',       await getLiveSessions());       } catch (e) { logger.error(e, 'live-sessions error'); } });
  socket.on('get-request-queue',       async () => { try { socket.emit('request-queue',       await getRequestQueue());       } catch (e) { logger.error(e, 'request-queue error'); } });
  socket.on('get-interpreter-presence',async () => { try { socket.emit('interpreter-presence',await getInterpreterPresence());} catch (e) { logger.error(e, 'interpreter-presence error'); } });
  socket.on('get-active-disputes',     async () => { try { socket.emit('active-disputes',     await getActiveDisputes());     } catch (e) { logger.error(e, 'active-disputes error'); } });
  socket.on('get-payout-queue',        async () => { try { socket.emit('payout-queue',        await getPayoutQueue());        } catch (e) { logger.error(e, 'payout-queue error'); } });
  socket.on('get-alerts',              async () => { try { socket.emit('operational-alerts',  await getAlerts());             } catch (e) { logger.error(e, 'alerts error'); } });
  socket.on('get-system-health',       async () => { try { socket.emit('system-health',       await getSystemHealth());       } catch (e) { logger.error(e, 'system-health error'); } });
  socket.on('get-snapshot',            async () => { try { socket.emit('snapshot',            await getSnapshot());           } catch (e) { logger.error(e, 'snapshot error'); } });

  socket.on('admin-resolve-dispute', async ({ disputeId }) => {
    try {
      await supabaseAdmin.from('disputes').update({ status: 'resolved' }).eq('id', disputeId);
      io.to('admins').emit('dispute-resolved', { id: disputeId });
    } catch (e) { logger.error(e, 'resolve-dispute error'); }
  });

  socket.on('admin-escalate-dispute', async ({ disputeId }) => {
    try {
      await supabaseAdmin.from('disputes').update({ status: 'escalated' }).eq('id', disputeId);
      io.to('admins').emit('dispute-escalated', { id: disputeId });
    } catch (e) { logger.error(e, 'escalate-dispute error'); }
  });

  socket.on('admin-approve-payout', async ({ payoutId }) => {
    try {
      await supabaseAdmin.from('payout_requests').update({ status: 'approved' }).eq('id', payoutId);
      io.to('admins').emit('payout-approved', { id: payoutId });
    } catch (e) { logger.error(e, 'approve-payout error'); }
  });

  logger.info({ userId: socket.userId }, 'Admin handlers registered');
}