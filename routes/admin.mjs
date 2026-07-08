// routes/admin.mjs
import { Router } from 'express';
import { supabaseAdmin, verifySupabaseToken } from '../config/supabase.mjs';
import { creditWallet } from '../db/walletRepo.mjs';
import { insertTransaction } from '../db/transactionRepo.mjs';
import { logger } from '../config/logger.mjs';

const router = Router();

async function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
  const token = auth.slice(7);
  const user = await verifySupabaseToken(token);
  if (!user) return res.status(401).json({ error: 'Invalid token' });
  if (user.app_metadata?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  req.user = user;
  next();
}

function initials(name) {
  return (name || 'U').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Users ────────────────────────────────────────────────────────────────────
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const { data: users, error } = await supabaseAdmin
      .from('users')
      .select('id, full_name, email, created_at, currency')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;

    // FIX: role/status were never queried at all — role was hardcoded to
    // 'client' for every user (interpreters and admins included). Real role
    // lives on the Supabase Auth user, not the public users table (same
    // place authHttp.mjs/authSocket.mjs read it from for actual
    // authorization) — same for 'status', which /users/:id/approve above
    // already writes to but this endpoint never read back.
    const { data: authList } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
    const roleMap = {};
    const statusMap = {};
    (authList?.users || []).forEach((au) => {
      roleMap[au.id]   = au.app_metadata?.role || au.user_metadata?.role || 'client';
      statusMap[au.id] = au.user_metadata?.status || 'active';
    });

    // FIX: session counts were always keyed by client_id, silently counting
    // 0 sessions for every interpreter (consistent with role being
    // hardcoded to 'client' everywhere). Now counts against the correct
    // column for each user's real role.
    const { data: sessions } = await supabaseAdmin
      .from('sessions')
      .select('client_id, interpreter_id');

    const clientCountMap = {};
    const interpreterCountMap = {};
    (sessions || []).forEach((s) => {
      if (s.client_id)      clientCountMap[s.client_id] = (clientCountMap[s.client_id] || 0) + 1;
      if (s.interpreter_id) interpreterCountMap[s.interpreter_id] = (interpreterCountMap[s.interpreter_id] || 0) + 1;
    });

    // FIX: 'spent' was hardcoded to '$0.00' for every user. Real spend is
    // the sum of that user's client-vault transactions (see the real
    // per-tick ledger entries created in billingService.mjs).
    const { data: clientTxns } = await supabaseAdmin
      .from('transactions')
      .select('user_id, amount')
      .eq('vault_type', 'client');

    const spentMap = {};
    (clientTxns || []).forEach((t) => {
      spentMap[t.user_id] = (spentMap[t.user_id] || 0) + Math.abs(t.amount || 0);
    });

    res.json((users || []).map(u => {
      const role = roleMap[u.id] || 'client';
      return {
        id:       u.id,
        name:     u.full_name || 'Unknown',
        email:    u.email,
        initials: initials(u.full_name),
        role,
        status:   statusMap[u.id] || 'active',
        joined:   new Date(u.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        sessions: role === 'interpreter' ? (interpreterCountMap[u.id] || 0) : (clientCountMap[u.id] || 0),
        // Spend only applies to clients — interpreters earn, they don't
        // spend, so this is genuinely not applicable rather than $0.00.
        spent:    role === 'client' ? `$${(spentMap[u.id] || 0).toFixed(2)}` : null,
      };
    }));
  } catch (err) {
    logger.error({ err }, 'Admin users error');
    res.status(500).json({ error: 'Failed to load users' });
  }
});

router.post('/users/:id/approve', requireAdmin, async (req, res) => {
  try {
    await supabaseAdmin.auth.admin.updateUserById(req.params.id, { user_metadata: { status: 'active' } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve user' });
  }
});

router.post('/users/invite', requireAdmin, async (req, res) => {
  try {
    const { email, role = 'interpreter' } = req.body;

    // Validate email format
    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Valid email address is required' });
    }

    // Whitelist allowed roles — prevents admin from accidentally assigning 'admin'
    // via this invite flow; admin role assignment requires direct DB access.
    const ALLOWED_INVITE_ROLES = ['interpreter', 'client'];
    if (!ALLOWED_INVITE_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${ALLOWED_INVITE_ROLES.join(', ')}` });
    }

    await supabaseAdmin.auth.admin.inviteUserByEmail(email, { data: { role } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to invite user' });
  }
});

// ── Interpreters ──────────────────────────────────────────────────────────────
router.get('/interpreters', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('interpreters')
      .select('*, users(full_name, email, created_at)')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;

    res.json((data || []).map(i => ({
      id:          i.user_id,
      name:        i.users?.full_name || 'Unknown',
      email:       i.users?.email || '',
      initials:    initials(i.users?.full_name),
      languages:   i.languages || [],
      rating:      i.rating || 0,
      isAvailable: i.is_available,
      isVerified:  i.is_verified,
      joined:      new Date(i.users?.created_at || i.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    })));
  } catch (err) {
    logger.error({ err }, 'Admin interpreters error');
    res.status(500).json({ error: 'Failed to load interpreters' });
  }
});

// ── Sessions ──────────────────────────────────────────────────────────────────
router.get('/sessions', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('sessions')
      .select('*, client:users!sessions_client_id_fkey(full_name), interpreter:users!sessions_interpreter_id_fkey(full_name)')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;

    res.json((data || []).map(s => {
      const started = s.started_at ? new Date(s.started_at) : null;
      const elapsedMins = started ? Math.floor((Date.now() - started.getTime()) / 60000) : 0;
      const STATUS_MAP = {
  active: 'live', in_progress: 'live',
  on_hold: 'hold', hold: 'hold',
  escalated: 'escalated', flagged: 'escalated',
  completed: 'completed', ended: 'completed',
}
// FIX: unrecognized statuses (e.g. 'pending', 'cancelled', 'timeout') were
// falling back to 'live' — actively misleading, since it implies an active
// call needing attention when the session may not even be running.
// 'completed' is a safer default: not urgent, not implying a live call.
const rawStatus = STATUS_MAP[s.status] ?? 'completed'

      return {
        id:                  s.id,
        status:              rawStatus,
        // FIX: toLang was set to the same value as fromLang (both read
        // s.language) — the sessions table never actually stored the
        // interpretation target language at all. Now reads the real
        // column added in migrations/20260709_sessions_to_language.sql.
        // Sessions created before that migration will show '—' for toLang,
        // since that history genuinely wasn't captured.
        fromLang:            s.language || 'EN',
        toLang:              s.to_language || '—',
        category:            s.purpose || 'General',
        interpreter:         s.interpreter?.full_name || 'Unassigned',
        interpreterInitials: initials(s.interpreter?.full_name),
        client:              s.client?.full_name || 'Unknown',
        ref:                 `#${String(s.id).slice(0, 8).toUpperCase()}`,
        startedAt:           started ? started.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '—',
        elapsedMins,
      };
    }));
  } catch (err) {
    logger.error({ err }, 'Admin sessions error');
    res.status(500).json({ error: 'Failed to load sessions' });
  }
});

// ── Transactions ──────────────────────────────────────────────────────────────
router.get('/transactions/export', requireAdmin, async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('transactions').select('*').order('created_at', { ascending: false }).limit(500);
    res.json({ data: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to export' });
  }
});

router.get('/transactions', requireAdmin, async (req, res) => {
  try {
    // FIX: previously showed every transactions row (client charges,
    // interpreter earnings, and platform revenue rows all mixed together
    // with no vault_type filter — platform/interpreter rows use a sentinel
    // PLATFORM_VAULT_ID with no matching users row, so they rendered as
    // "Unknown"), and fabricated platform/net as a flat guessed 10% split
    // with type hardcoded to 'audio' and interpreter hardcoded to the
    // literal string 'Interpreter' for every row.
    //
    // billingService.mjs actually records three REAL, separate ledger
    // entries per billing tick (client charge / interpreter earning /
    // platform revenue), all sharing the same session_id. This now uses the
    // client charge as the primary row and pulls the real platform fee and
    // interpreter net from the matching sibling entries for that same
    // session, instead of guessing a split.
    const { data: clientTxns, error } = await supabaseAdmin
      .from('transactions')
      .select('*, users(full_name), sessions(session_type, interpreter:users!sessions_interpreter_id_fkey(full_name))')
      .eq('vault_type', 'client')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;

    const sessionIds = [...new Set((clientTxns || []).map(t => t.session_id).filter(Boolean))];

    const { data: siblingTxns } = sessionIds.length
      ? await supabaseAdmin
          .from('transactions')
          .select('session_id, vault_type, amount, created_at')
          .in('session_id', sessionIds)
          .in('vault_type', ['platform', 'interpreter'])
      : { data: [] };

    // Multiple billing ticks can share a session_id, so pick the sibling
    // entry closest in time to this specific charge rather than any match.
    const closestSibling = (t, vaultType) => {
      const candidates = (siblingTxns || []).filter(
        (s) => s.session_id === t.session_id && s.vault_type === vaultType
      );
      if (!candidates.length) return null;
      const targetTime = new Date(t.created_at).getTime();
      return candidates.reduce((best, cur) =>
        Math.abs(new Date(cur.created_at).getTime() - targetTime) <
        Math.abs(new Date(best.created_at).getTime() - targetTime) ? cur : best
      );
    };

    res.json((clientTxns || []).map((t) => {
      const platformTxn    = closestSibling(t, 'platform');
      const interpreterTxn = closestSibling(t, 'interpreter');

      return {
        id:          t.id,
        amount:      Math.abs(t.amount || 0),
        platform:    platformTxn    ? Math.abs(platformTxn.amount)    : null,
        net:         interpreterTxn ? Math.abs(interpreterTxn.amount) : null,
        status:      t.status || 'completed',
        type:        t.sessions?.session_type || 'audio',
        category:    t.description || 'Session',
        client:      t.users?.full_name || 'Unknown',
        clientInit:  initials(t.users?.full_name),
        interpreter: t.sessions?.interpreter?.full_name || 'Unassigned',
        interpInit:  initials(t.sessions?.interpreter?.full_name),
        ref:         `TXN-${String(t.id).slice(0, 8).toUpperCase()}`,
        date:        new Date(t.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        currency:    t.currency || 'USD',
      };
    }));
  } catch (err) {
    logger.error({ err }, 'Admin transactions error');
    res.status(500).json({ error: 'Failed to load transactions' });
  }
});

// ── Disputes ──────────────────────────────────────────────────────────────────
// GET /v1/admin/disputes
// Shows every dispute with both parties clearly identified, which side
// raised it (client billing/charge complaint vs interpreter complaint),
// the session it's tied to, and the disputed amount.
router.get('/disputes', requireAdmin, async (req, res) => {
  try {
    const { status } = req.query;

    let query = supabaseAdmin
      .from('disputes')
      .select(`
        id, session_id, reason, status, resolution, admin_notes, raised_by, created_at, updated_at,
        client:users!disputes_client_id_fkey(id, full_name, email),
        interpreter:users!disputes_interpreter_id_fkey(id, full_name),
        session:sessions(id, session_type, language, started_at)
      `)
      .order('created_at', { ascending: false })
      .limit(100);

    if (status && status !== 'all') query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;

    const sessionIds = [...new Set((data || []).map(d => d.session_id).filter(Boolean))];
    let amountsBySession = {};
    if (sessionIds.length) {
      const { data: charges } = await supabaseAdmin
        .from('transactions')
        .select('session_id, amount')
        .in('session_id', sessionIds)
        .in('type', ['charge_active', 'charge_hold']);

      amountsBySession = (charges || []).reduce((acc, t) => {
        acc[t.session_id] = (acc[t.session_id] ?? 0) + (t.amount ?? 0);
        return acc;
      }, {});
    }

    const disputes = (data || []).map(d => ({
      id:            d.id,
      ref:           `#${String(d.id).slice(0, 8).toUpperCase()}`,
      title:         d.reason || 'Dispute',
      status:        d.status || 'open',
      raisedByRole:  d.raised_by === d.client?.id ? 'client' : 'interpreter',
      client:        d.client?.full_name ?? 'Unknown',
      clientEmail:   d.client?.email ?? null,
      interpreter:   d.interpreter?.full_name ?? 'Unknown',
      sessionType:   d.session?.session_type ?? null,
      language:      d.session?.language ?? null,
      amount:        amountsBySession[d.session_id]
                        ? parseFloat(amountsBySession[d.session_id].toFixed(2))
                        : null,
      resolution:    d.resolution ?? null,
      adminNotes:    d.admin_notes ?? null,
      timeAgo:       timeAgo(d.created_at),
      createdAt:     d.created_at,
    }));

    res.json(disputes);
  } catch (err) {
    logger.error({ err }, 'Admin disputes error');
    res.status(500).json({ error: 'Failed to load disputes' });
  }
});

router.post('/disputes/:id/resolve', requireAdmin, async (req, res) => {
  try {
    // FIX: two real bugs here.
    // 1. `action === 'refund' ? 'resolved' : 'resolved'` — both branches
    //    produced the identical status, so 'action' had no actual effect.
    //    'resolution' (a separate column, already selected in GET
    //    /disputes above) is where the refund-vs-denied outcome belongs —
    //    'status' correctly stays 'resolved' either way, since both
    //    conclude the dispute.
    // 2. Choosing "Refund" only ever updated a status label — no money
    //    actually moved. This now credits the client's wallet for real via
    //    creditWallet() and records a proper transactions ledger entry,
    //    with a guard against double-crediting if a dispute is resolved
    //    more than once.
    const { action, notes } = req.body;
    if (!['refund', 'deny'].includes(action)) {
      return res.status(400).json({ error: 'action must be "refund" or "deny"' });
    }

    const { data: dispute, error: fetchErr } = await supabaseAdmin
      .from('disputes')
      .select('id, session_id, client_id, status')
      .eq('id', req.params.id)
      .single();
    if (fetchErr || !dispute) {
      return res.status(404).json({ error: 'Dispute not found' });
    }
    if (dispute.status === 'resolved') {
      return res.status(409).json({ error: 'This dispute has already been resolved' });
    }

    let refundAmount = null;

    if (action === 'refund') {
      // Real refund amount: what the client was actually charged for this
      // session (sum of their client-vault transactions), not a guess.
      const { data: charges } = await supabaseAdmin
        .from('transactions')
        .select('amount')
        .eq('session_id', dispute.session_id)
        .eq('vault_type', 'client');

      refundAmount = (charges || []).reduce((sum, t) => sum + Math.abs(t.amount || 0), 0);

      if (refundAmount > 0) {
        await creditWallet(dispute.client_id, refundAmount, 'client');
        await insertTransaction({
          userId:      dispute.client_id,
          amount:      refundAmount,
          currency:    'USD',
          type:        'refund',
          description: 'Dispute resolution refund',
          sessionId:   dispute.session_id,
          referenceId: dispute.id,
          vaultType:   'client',
        });
      }
    }

    const { error: updateErr } = await supabaseAdmin
      .from('disputes')
      .update({
        status:      'resolved',
        resolution:  action === 'refund' ? 'refund' : 'denied',
        admin_notes: notes ?? null,
        updated_at:  new Date().toISOString(),
      })
      .eq('id', req.params.id);
    if (updateErr) throw updateErr;

    res.json({ success: true, refunded: refundAmount });
  } catch (err) {
    logger.error({ err }, 'Dispute resolve error');
    res.status(500).json({ error: 'Failed to resolve dispute' });
  }
});

// ── Reviews ───────────────────────────────────────────────────────────────────
router.get('/reviews', requireAdmin, async (req, res) => {
  try {
    // FIX: was hardcoding interpreter: 'Interpreter' / interpInit: 'IN' for
    // every row. Joins through sessions to the real interpreter, same
    // pattern already used correctly in GET /sessions below.
    const { data, error } = await supabaseAdmin
      .from('session_ratings')
      .select('*, users!session_ratings_rated_by_fkey(full_name), sessions(language, interpreter:users!sessions_interpreter_id_fkey(full_name))')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;

    res.json((data || []).map(r => ({
      id:          r.id,
      rating:      r.interpreter_rating || r.call_quality || 0,
      text:        r.comment || '',
      flagged:     r.flagged || false,
      client:      r.users?.full_name || 'Unknown',
      clientInit:  initials(r.users?.full_name),
      interpreter: r.sessions?.interpreter?.full_name || 'Unknown',
      interpInit:  initials(r.sessions?.interpreter?.full_name),
      category:    r.sessions?.language || 'General',
      date:        new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    })));
  } catch (err) {
    logger.error({ err }, 'Admin reviews error');
    res.status(500).json({ error: 'Failed to load reviews' });
  }
});

router.post('/reviews/:id/dismiss-flag', requireAdmin, async (req, res) => {
  try {
    await supabaseAdmin.from('session_ratings').update({ flagged: false }).eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to dismiss flag' });
  }
});

router.delete('/reviews/:id', requireAdmin, async (req, res) => {
  try {
    await supabaseAdmin.from('session_ratings').delete().eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete review' });
  }
});

// ── Payouts ───────────────────────────────────────────────────────────────────
router.get('/payouts', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('payout_requests')
      .select('*')
      .order('requested_at', { ascending: false })
      .limit(50);
    if (error) throw error;

    const interpreterIds = [...new Set((data || []).map(p => p.interpreter_id).filter(Boolean))];
    let usersMap = {};
    if (interpreterIds.length) {
      const { data: users } = await supabaseAdmin
        .from('users')
        .select('id, full_name, email')
        .in('id', interpreterIds);
      usersMap = Object.fromEntries((users || []).map(u => [u.id, u]));
    }

    res.json((data || []).map(p => {
      const u = usersMap[p.interpreter_id];
      return {
        id:       p.id,
        name:     u?.full_name || 'Unknown',
        email:    u?.email || '',
        initials: initials(u?.full_name),
        amount:   `$${parseFloat(p.amount || 0).toFixed(2)}`,
        status:   p.status || 'pending',
        period:   new Date(p.requested_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
        sessions: p.session_count || 0,
      };
    }));
  } catch (err) {
    logger.error({ err }, 'Admin payouts error');
    res.status(500).json({ error: 'Failed to load payouts' });
  }
});

// ── Requests ──────────────────────────────────────────────────────────────────
router.get('/requests', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('sessions')
      .select('*, users!sessions_client_id_fkey(full_name)')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(50);
    if (error) throw error;

    res.json((data || []).map(r => ({
      id:        r.id,
      language:  r.language || 'Unknown',
      purpose:   r.purpose || 'General',
      type:      r.session_type || 'audio',
      clientId:  r.client_id,
      client:    r.users?.full_name || 'Unknown',
      createdAt: r.created_at,
      status:    'pending',
    })));
  } catch (err) {
    logger.error({ err }, 'Admin requests error');
    res.status(500).json({ error: 'Failed to load requests' });
  }
});

// ── Settings ──────────────────────────────────────────────────────────────────
const SETTINGS_FIELD_MAP = {
  commissionRate: 'commission_rate',
  sessionTimeoutMinutes: 'session_timeout_minutes',
  requestTimeoutSeconds: 'request_timeout_seconds',
  minTopUpAmount: 'min_top_up_amount',
  maxSessionDurationMinutes: 'max_session_duration_minutes',
  autoAssignEnabled: 'auto_assign_enabled',
  emailNotificationsEnabled: 'email_notifications_enabled',
  smsNotificationsEnabled: 'sms_notifications_enabled',
  maintenanceMode: 'maintenance_mode',
};

function toCamelSettings(row) {
  const out = {};
  for (const [camel, snake] of Object.entries(SETTINGS_FIELD_MAP)) {
    out[camel] = row[snake];
  }
  return out;
}

function toSnakeSettings(body) {
  const out = {};
  for (const [camel, snake] of Object.entries(SETTINGS_FIELD_MAP)) {
    if (body[camel] !== undefined) out[snake] = body[camel];
  }
  return out;
}

router.get('/settings', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('platform_settings')
      .select('*')
      .eq('id', 1)
      .single();
    if (error && error.code !== 'PGRST116') throw error; // ignore "no rows found"

    res.json(data ? toCamelSettings(data) : {
      commissionRate: 10,
      sessionTimeoutMinutes: 30,
      requestTimeoutSeconds: 180,
      minTopUpAmount: 5,
      maxSessionDurationMinutes: 120,
      autoAssignEnabled: false,
      emailNotificationsEnabled: true,
      smsNotificationsEnabled: false,
      maintenanceMode: false,
    });
  } catch (err) {
    logger.error({ err }, 'Admin settings fetch error');
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

router.put('/settings', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('platform_settings')
      .upsert({ id: 1, ...toSnakeSettings(req.body), updated_at: new Date().toISOString() })
      .select()
      .single();
    if (error) throw error;
    res.json(toCamelSettings(data));
  } catch (err) {
    logger.error({ err }, 'Admin settings update error');
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// ── Communications ────────────────────────────────────────────────────────────
router.get('/communications', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('conversations')
      .select(`
        *,
        client:users!conversations_client_id_fkey(full_name),
        interpreter:users!conversations_interpreter_id_fkey(full_name),
        messages(id, text, sender_id, read, created_at)
      `)
      .order('updated_at', { ascending: false })
      .limit(50);
    if (error) throw error;

    const threads = (data || []).map(c => {
      const msgs = c.messages ?? [];
      const last = msgs[msgs.length - 1];
      return {
        id:           c.id,
        type:         'support', // conversations are client<->interpreter threads; disputes/system handled separately
        participants: [
          { name: c.client?.full_name ?? 'Client' },
          { name: c.interpreter?.full_name ?? 'Interpreter' },
        ],
        lastMessage:  last?.text ?? '',
        unreadCount:  msgs.filter(m => !m.read).length,
        updatedAt:    c.updated_at,
        messages:     msgs,
      };
    });

    res.json(threads);
  } catch (err) {
    logger.error({ err }, 'Admin communications error');
    res.json([]);
  }
});

router.post('/communications/:id/reply', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { text } = req.body;

    if (!text?.trim()) {
      return res.status(400).json({ error: 'Reply text is required' });
    }

    const { data, error } = await supabaseAdmin
      .from('messages')
      .insert({
        conversation_id: id,
        sender_id:        req.user.id,
        text,
        read:             false,
      })
      .select()
      .single();

    if (error) throw error;

    await supabaseAdmin
      .from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', id);

    logger.info({ adminId: req.user.id, conversationId: id }, 'Admin sent reply');
    res.json(data);
  } catch (err) {
    logger.error({ err, conversationId: req.params.id }, 'Admin reply failed');
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

export default router;
