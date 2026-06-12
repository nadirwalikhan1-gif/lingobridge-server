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
  if (user.user_metadata?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
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
      .select('*, client:users!sessions_client_id_fkey(full_name), interpreter:interpreters!sessions_interpreter_id_fkey(users(full_name))')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;

    res.json((data || []).map(s => {
      const started = s.started_at ? new Date(s.started_at) : null;
      const elapsedMins = started ? Math.floor((Date.now() - started.getTime()) / 60000) : 0;
      const rawStatus = s.status === 'active' ? 'live' : s.status === 'completed' ? 'completed' : s.status || 'completed';

      return {
        id:                  s.id,
        status:              rawStatus,
        fromLang:            s.language || 'EN',
        toLang:              s.language || 'EN',
        category:            s.purpose || 'General',
        interpreter:         s.interpreter?.users?.full_name || 'Unassigned',
        interpreterInitials: initials(s.interpreter?.users?.full_name),
        client:              s.client?.full_name || 'Unknown',
        ref:                 `#${s.id.slice(0, 8).toUpperCase()}`,
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
      ref:         `TXN-${t.id.slice(0, 8).toUpperCase()}`,
      date:        new Date(t.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      currency:    t.currency || 'USD',
    })));
  } catch (err) {
    logger.error({ err }, 'Admin transactions error');
    res.status(500).json({ error: 'Failed to load transactions' });
  }
});

// ── Disputes ──────────────────────────────────────────────────────────────────
router.get('/disputes', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('disputes')
      .select('*, raised_by_user:users!disputes_raised_by_fkey(full_name)')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;

    res.json((data || []).map(d => ({
      id:          d.id,
      title:       d.reason || 'Dispute',
      ref:         `#${d.id.slice(0, 8).toUpperCase()}`,
      status:      d.status || 'open',
      client:      d.raised_by_user?.full_name || 'Unknown',
      interpreter: null,
      amount:      null,
      timeAgo:     timeAgo(d.created_at),
    })));
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
      .select('*, users!session_ratings_client_id_fkey(full_name), sessions(language)')
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
      .select('*, users!payout_requests_interpreter_id_fkey(full_name, email)')
      .order('requested_at', { ascending: false })
      .limit(50);
    if (error) throw error;

    res.json((data || []).map(p => ({
      id:       p.id,
      name:     p.users?.full_name || 'Unknown',
      email:    p.users?.email || '',
      initials: initials(p.users?.full_name),
      amount:   `$${parseFloat(p.amount || 0).toFixed(2)}`,
      status:   p.status || 'pending',
      period:   new Date(p.requested_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
      sessions: p.session_count || 0,
    })));
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

export default router;