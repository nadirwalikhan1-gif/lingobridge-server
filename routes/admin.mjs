// routes/admin.mjs
import { Router } from 'express';
import { supabaseAdmin, verifySupabaseToken } from '../config/supabase.mjs';
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

    const { data: sessionCounts } = await supabaseAdmin
      .from('sessions')
      .select('client_id');

    const countMap = {};
    (sessionCounts || []).forEach(s => { countMap[s.client_id] = (countMap[s.client_id] || 0) + 1; });

    res.json((users || []).map(u => ({
      id:       u.id,
      name:     u.full_name || 'Unknown',
      email:    u.email,
      initials: initials(u.full_name),
      role:     'client',
      status:   'active',
      joined:   new Date(u.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      sessions: countMap[u.id] || 0,
      spent:    '$0.00',
    })));
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
const rawStatus = STATUS_MAP[s.status] ?? 'live'

      return {
        id:                  s.id,
        status:              rawStatus,
        fromLang:            s.language || 'EN',
        toLang:              s.language || 'EN',
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
    const { data, error } = await supabaseAdmin
      .from('transactions')
      .select('*, users(full_name)')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;

    res.json((data || []).map(t => ({
      id:          t.id,
      amount:      Math.abs(t.amount || 0),
      platform:    parseFloat((Math.abs(t.amount || 0) * 0.1).toFixed(2)),
      net:         parseFloat((Math.abs(t.amount || 0) * 0.9).toFixed(2)),
      status:      t.status || 'completed',
      type:        'audio',
      category:    t.description || 'Session',
      client:      t.users?.full_name || 'Unknown',
      clientInit:  initials(t.users?.full_name),
      interpreter: 'Interpreter',
      interpInit:  'IN',
      ref:         `TXN-${String(t.id).slice(0, 8).toUpperCase()}`,
      date:        new Date(t.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      currency:    t.currency || 'USD',
    })));
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
    const { action } = req.body;
    const status = action === 'refund' ? 'resolved' : 'resolved';
    await supabaseAdmin.from('disputes').update({ status }).eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resolve dispute' });
  }
});

// ── Reviews ───────────────────────────────────────────────────────────────────
router.get('/reviews', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('session_ratings')
      .select('*, users!session_ratings_rated_by_fkey(full_name), sessions(language)')
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
      interpreter: 'Interpreter',
      interpInit:  'IN',
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
