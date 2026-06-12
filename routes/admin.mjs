// routes/admin.mjs
// Admin REST API routes — requires admin role

import { Router } from 'express';
import { supabaseAdmin, verifySupabaseToken } from '../config/supabase.mjs';
import { logger } from '../config/logger.mjs';

const router = Router();

// ── Auth + Admin guard ────────────────────────────────────────────────────────
async function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });

  const token = auth.slice(7);
  const user = await verifySupabaseToken(token);
  if (!user) return res.status(401).json({ error: 'Invalid token' });

  const role = user.user_metadata?.role;
  if (role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

  req.user = user;
  next();
}

// ── GET /v1/admin/users ───────────────────────────────────────────────────────
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const { data: users, error } = await supabaseAdmin
      .from('users')
      .select('id, full_name, email, created_at, currency')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;

    // Get session counts per user
    const { data: sessionCounts } = await supabaseAdmin
      .from('sessions')
      .select('client_id')
      .in('client_id', (users || []).map(u => u.id));

    const countMap = {};
    (sessionCounts || []).forEach(s => {
      countMap[s.client_id] = (countMap[s.client_id] || 0) + 1;
    });

    const formatted = (users || []).map(u => ({
      id:       u.id,
      name:     u.full_name || 'Unknown',
      email:    u.email,
      initials: (u.full_name || 'U').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2),
      role:     'client',
      status:   'active',
      joined:   new Date(u.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      sessions: countMap[u.id] || 0,
      spent:    '$0.00',
    }));

    res.json(formatted);
  } catch (err) {
    logger.error({ err }, 'Admin users error');
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// ── POST /v1/admin/users/:id/approve ─────────────────────────────────────────
router.post('/users/:id/approve', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(req.params.id, {
      user_metadata: { status: 'active' }
    });
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Approve user error');
    res.status(500).json({ error: 'Failed to approve user' });
  }
});

// ── POST /v1/admin/users/invite ───────────────────────────────────────────────
router.post('/users/invite', requireAdmin, async (req, res) => {
  try {
    const { email, role = 'interpreter' } = req.body;
    const { error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      data: { role }
    });
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Invite user error');
    res.status(500).json({ error: 'Failed to invite user' });
  }
});

// ── GET /v1/admin/interpreters ────────────────────────────────────────────────
router.get('/interpreters', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('interpreters')
      .select('*, users(full_name, email, created_at)')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;

    const formatted = (data || []).map(i => ({
      id:          i.user_id,
      name:        i.users?.full_name || 'Unknown',
      email:       i.users?.email || '',
      languages:   i.languages || [],
      rating:      i.rating || 0,
      isAvailable: i.is_available,
      isVerified:  i.is_verified,
      joined:      new Date(i.users?.created_at || i.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    }));

    res.json(formatted);
  } catch (err) {
    logger.error({ err }, 'Admin interpreters error');
    res.status(500).json({ error: 'Failed to load interpreters' });
  }
});

// ── GET /v1/admin/sessions ────────────────────────────────────────────────────
router.get('/sessions', requireAdmin, async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const { data, error, count } = await supabaseAdmin
      .from('sessions')
      .select('*, users!sessions_client_id_fkey(full_name)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    res.json({ data: data || [], total: count || 0, page, limit });
  } catch (err) {
    logger.error({ err }, 'Admin sessions error');
    res.status(500).json({ error: 'Failed to load sessions' });
  }
});

// ── GET /v1/admin/transactions ────────────────────────────────────────────────
router.get('/transactions', requireAdmin, async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const { data, error, count } = await supabaseAdmin
      .from('transactions')
      .select('*, users(full_name)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    res.json({ data: data || [], total: count || 0, page, limit });
  } catch (err) {
    logger.error({ err }, 'Admin transactions error');
    res.status(500).json({ error: 'Failed to load transactions' });
  }
});

// ── GET /v1/admin/disputes ────────────────────────────────────────────────────
router.get('/disputes', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('disputes')
      .select('*, users!disputes_raised_by_fkey(full_name)')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json({ data: data || [] });
  } catch (err) {
    logger.error({ err }, 'Admin disputes error');
    res.status(500).json({ error: 'Failed to load disputes' });
  }
});

// ── GET /v1/admin/reviews ─────────────────────────────────────────────────────
router.get('/reviews', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('session_ratings')
      .select('*, sessions(language, session_type)')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json({ data: data || [] });
  } catch (err) {
    logger.error({ err }, 'Admin reviews error');
    res.status(500).json({ error: 'Failed to load reviews' });
  }
});

// ── GET /v1/admin/payouts ─────────────────────────────────────────────────────
router.get('/payouts', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('payout_requests')
      .select('*, users!payout_requests_interpreter_id_fkey(full_name)')
      .order('requested_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json({ data: data || [] });
  } catch (err) {
    logger.error({ err }, 'Admin payouts error');
    res.status(500).json({ error: 'Failed to load payouts' });
  }
});

// ── GET /v1/admin/requests ────────────────────────────────────────────────────
router.get('/requests', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('sessions')
      .select('*, users!sessions_client_id_fkey(full_name)')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(50);

    if (error) throw error;
    res.json({ data: data || [] });
  } catch (err) {
    logger.error({ err }, 'Admin requests error');
    res.status(500).json({ error: 'Failed to load requests' });
  }
});

export default router;