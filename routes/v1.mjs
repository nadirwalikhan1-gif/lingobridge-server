import { Router } from 'express';
import { supabaseAdmin, verifySupabaseToken } from '../config/supabase.mjs';
import { getSessionsByUser } from '../db/sessionRepo.mjs';
import { getAvailableBalance } from '../db/walletRepo.mjs';
import { logger } from '../config/logger.mjs';

const router = Router();

// ── Token helper (add this here) ──────────────────────────────────────────────
function generateToken() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}
// ── Auth middleware ────────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }
  const token = auth.slice(7);
  const user = await verifySupabaseToken(token);
  if (!user) return res.status(401).json({ error: 'Invalid token' });
  req.user = user;
  next();
}

// ── GET /v1/dashboard/stats ────────────────────────────────────────────────────
router.get('/dashboard/stats', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Total sessions count
    const { count: totalSessions } = await supabaseAdmin
      .from('sessions')
      .select('*', { count: 'exact', head: true })
      .eq('client_id', userId);

    // Sessions this month
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const { count: monthSessions } = await supabaseAdmin
      .from('sessions')
      .select('*', { count: 'exact', head: true })
      .eq('client_id', userId)
      .gte('created_at', startOfMonth.toISOString());

    // Favourites count
    const { count: favourites } = await supabaseAdmin
      .from('favorites')
      .select('*', { count: 'exact', head: true })
      .eq('client_id', userId);

    // Wallet balance
    let walletBalance = 0;
    try {
      const wallet = await getAvailableBalance(userId, 'client');
      walletBalance = wallet.availableBalance;
    } catch (_) {}

    // Month debits from transactions
    const { data: txData } = await supabaseAdmin
      .from('transactions')
      .select('amount')
      .eq('user_id', userId)
      .eq('type', 'debit')
      .gte('created_at', startOfMonth.toISOString());

    const monthDebits = (txData || []).reduce((sum, t) => sum + Math.abs(t.amount), 0);

    res.json({
      totalSessions: totalSessions || 0,
      monthSessions: monthSessions || 0,
      favourites: favourites || 0,
      walletBalance,
      monthDebits,
    });
  } catch (err) {
    logger.error({ err }, 'Dashboard stats error');
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ── GET /v1/sessions/recent ────────────────────────────────────────────────────
router.get('/sessions/recent', requireAuth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 5;
    const sessions = await getSessionsByUser(req.user.id, limit, 0);
    res.json({ sessions });
  } catch (err) {
    logger.error({ err }, 'Recent sessions error');
    res.status(500).json({ error: 'Failed to load sessions' });
  }
});

// ── GET /v1/sessions/upcoming ──────────────────────────────────────────────────
router.get('/sessions/upcoming', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('sessions')
      .select('*')
      .eq('client_id', req.user.id)
      .eq('status', 'scheduled')
      .gte('scheduled_at', new Date().toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(5);

    if (error) throw error;
    res.json({ sessions: data || [] });
  } catch (err) {
    logger.error({ err }, 'Upcoming sessions error');
    res.status(500).json({ error: 'Failed to load upcoming sessions' });
  }
});

// ── GET /v1/sessions ───────────────────────────────────────────────────────────
router.get('/sessions', requireAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const sessions = await getSessionsByUser(req.user.id, limit, offset);

    const { count } = await supabaseAdmin
      .from('sessions')
      .select('*', { count: 'exact', head: true })
      .eq('client_id', req.user.id);

    res.json({ sessions, total: count || 0, page, limit });
  } catch (err) {
    logger.error({ err }, 'Sessions list error');
    res.status(500).json({ error: 'Failed to load sessions' });
  }
});

// ── POST /v1/sessions/rebook ───────────────────────────────────────────────────
router.post('/sessions/rebook', requireAuth, async (req, res) => {
  try {
    const { sessionId } = req.body;
    const { data, error } = await supabaseAdmin
      .from('sessions')
      .select('language, purpose, session_type, currency')
      .eq('id', sessionId)
      .eq('client_id', req.user.id)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Session not found' });
    res.json({ session: data });
  } catch (err) {
    logger.error({ err }, 'Rebook error');
    res.status(500).json({ error: 'Failed to rebook session' });
  }
});

// ── GET /v1/sessions/:id ───────────────────────────────────────────────────────
router.get('/sessions/:id', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('sessions')
      .select('*')
      .eq('id', req.params.id)
      .eq('client_id', req.user.id)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Session not found' });
    res.json({ session: data });
  } catch (err) {
    logger.error({ err }, 'Session fetch error');
    res.status(500).json({ error: 'Failed to load session' });
  }
});

// ── POST /v1/sessions/:id/rate ─────────────────────────────────────────────────
router.post('/sessions/:id/rate', requireAuth, async (req, res) => {
  try {
    const { callQuality, interpreterRating, comment } = req.body;
    const { data, error } = await supabaseAdmin
      .from('session_ratings')
      .upsert({
        session_id: req.params.id,
        client_id: req.user.id,
        call_quality: callQuality,
        interpreter_rating: interpreterRating,
        comment,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ rating: data });
  } catch (err) {
    logger.error({ err }, 'Rating error');
    res.status(500).json({ error: 'Failed to submit rating' });
  }
});

// ── GET /v1/wallet/balance ─────────────────────────────────────────────────────
router.get('/wallet/balance', requireAuth, async (req, res) => {
  try {
    const wallet = await getAvailableBalance(req.user.id, 'client');
    res.json(wallet);
  } catch (err) {
    logger.error({ err }, 'Wallet balance error');
    res.json({ balance: 0, reservedBalance: 0, availableBalance: 0, currency: 'USD' });
  }
});

// ── GET /v1/wallet ─────────────────────────────────────────────────────────────
router.get('/wallet', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('wallets')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('vault_type', 'client')
      .single();

    if (error) throw error;
    res.json({ data });
  } catch (err) {
    logger.error({ err }, 'Wallet fetch error');
    res.json({ data: { balance: 0, reserved_balance: 0, currency: 'USD' } });
  }
});

// ── GET /v1/wallet/transactions ────────────────────────────────────────────────
router.get('/wallet/transactions', requireAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const type = req.query.type;
    const dateFilter = req.query.date;

    let query = supabaseAdmin
      .from('transactions')
      .select('*', { count: 'exact' })
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (type && type !== 'all') query = query.eq('type', type);

    if (dateFilter) {
      const now = new Date();
      if (dateFilter === 'today') {
        const start = new Date(now); start.setHours(0,0,0,0);
        query = query.gte('created_at', start.toISOString());
      } else if (dateFilter === 'week') {
        const start = new Date(now); start.setDate(now.getDate() - 7);
        query = query.gte('created_at', start.toISOString());
      } else if (dateFilter === 'month') {
        const start = new Date(now); start.setDate(1); start.setHours(0,0,0,0);
        query = query.gte('created_at', start.toISOString());
      }
    }

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ data: data || [], total: count || 0, page, limit });
  } catch (err) {
    logger.error({ err }, 'Transactions error');
    res.status(500).json({ error: 'Failed to load transactions' });
  }
});

// ── GET /v1/wallet/payment-methods ────────────────────────────────────────────
router.get('/wallet/payment-methods', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('payment_methods')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ data: data || [] });
  } catch (err) {
    logger.error({ err }, 'Payment methods error');
    res.json({ data: [] });
  }
});

// ── POST /v1/wallet/top-up ─────────────────────────────────────────────────────
router.post('/wallet/top-up', requireAuth, async (req, res) => {
  try {
    const { amount, paymentMethodId } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const { data, error } = await supabaseAdmin.rpc('credit_wallet_topup', {
      p_user_id: req.user.id,
      p_amount: amount,
      p_vault_type: 'client',
    });

    if (error) throw error;
    res.json({ success: true, wallet: data });
  } catch (err) {
    logger.error({ err }, 'Top-up error');
    res.status(500).json({ error: 'Failed to top up wallet' });
  }
});

// ── POST /v1/wallet/export ─────────────────────────────────────────────────────
router.post('/wallet/export', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('transactions')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) throw error;
    res.json({ data: data || [] });
  } catch (err) {
    logger.error({ err }, 'Export error');
    res.status(500).json({ error: 'Failed to export' });
  }
});

// ── GET /v1/activity ──────────────────────────────────────────────────────────
router.get('/activity', requireAuth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const { data, error } = await supabaseAdmin
      .from('transactions')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    res.json({ activities: data || [] });
  } catch (err) {
    logger.error({ err }, 'Activity error');
    res.json({ activities: [] });
  }
});

// ── GET /v1/favourites ────────────────────────────────────────────────────────
router.get('/favourites', requireAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const { data, error, count } = await supabaseAdmin
      .from('favorites')
      .select('*', { count: 'exact' })
      .eq('client_id', req.user.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    res.json({ data: data || [], total: count || 0, page, limit });
  } catch (err) {
    logger.error({ err }, 'Favourites error');
    res.status(500).json({ error: 'Failed to load favourites' });
  }
});

// ── POST /v1/favourites ───────────────────────────────────────────────────────
router.post('/favourites', requireAuth, async (req, res) => {
  try {
    const { interpreterId } = req.body;
    const { data, error } = await supabaseAdmin
      .from('favorites')
      .insert({ client_id: req.user.id, interpreter_id: interpreterId })
      .select()
      .single();

    if (error) throw error;
    res.json({ data });
  } catch (err) {
    logger.error({ err }, 'Add favourite error');
    res.status(500).json({ error: 'Failed to add favourite' });
  }
});

// ── DELETE /v1/favourites/:interpreterId ──────────────────────────────────────
router.delete('/favourites/:interpreterId', requireAuth, async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('favorites')
      .delete()
      .eq('client_id', req.user.id)
      .eq('interpreter_id', req.params.interpreterId);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Remove favourite error');
    res.status(500).json({ error: 'Failed to remove favourite' });
  }
});

// ── GET /v1/reviews ───────────────────────────────────────────────────────────
router.get('/reviews', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('session_ratings')
      .select('*, session:session_id(language, session_type, started_at)')
      .eq('client_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ data: data || [] });
  } catch (err) {
    logger.error({ err }, 'Reviews error');
    res.json({ data: [] });
  }
});

// ── GET /v1/interpreters ──────────────────────────────────────────────────────
router.get('/interpreters', requireAuth, async (req, res) => {
  try {
    const { language, category, sessionType } = req.query;

    let query = supabaseAdmin
      .from('interpreter_profiles')
      .select('*')
      .eq('is_available', true);

    if (language) query = query.contains('languages', [language]);
    if (category) query = query.contains('specializations', [category]);

    const { data, error } = await query.limit(20);
    if (error) throw error;
    res.json({ interpreters: data || [] });
  } catch (err) {
    logger.error({ err }, 'Interpreters error');
    res.json({ interpreters: [] });
  }
});

// ── GET /v1/messages ─────────────────────────────────────────────────────────
router.get('/messages', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('conversations')
      .select('*, messages(count)')
      .eq('client_id', req.user.id)
      .order('updated_at', { ascending: false });

    if (error) throw error;
    res.json({ conversations: data || [] });
  } catch (err) {
    logger.error({ err }, 'Messages error');
    res.json({ conversations: [] });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ── TEAM ROUTES ─────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// Helper: get or create team for user
async function getUserTeam(userId) {
  const { data, error } = await supabaseAdmin
    .from('teams')
    .select('*')
    .eq('owner_id', userId)
    .single();

  if (error || !data) {
    const { data: newTeam, error: createErr } = await supabaseAdmin
      .from('teams')
      .insert({
        owner_id: userId,
        name: 'Your Team',
        plan: 'Starter',
        seats: 5,
        departments: ['General'],
        rates: { video: 1.79, audio: 1.49 },
        billing_cycle: 'Monthly',
        next_invoice: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .select()
      .single();

    if (createErr) throw createErr;
    return newTeam;
  }

  return data;
}

// GET /v1/teams/me
router.get('/teams/me', requireAuth, async (req, res) => {
  try {
    const team = await getUserTeam(req.user.id);
    res.json({
      id: team.id,
      name: team.name,
      plan: team.plan,
      seats: team.seats,
      departments: team.departments || [],
      rates: team.rates || { video: 1.79, audio: 1.49 },
      billingCycle: team.billing_cycle,
      nextInvoice: team.next_invoice,
    });
  } catch (err) {
    logger.error({ err }, 'Team fetch error');
    res.status(500).json({ error: 'Failed to load team' });
  }
});

// GET /v1/teams/me/members
router.get('/teams/me/members', requireAuth, async (req, res) => {
  try {
    const team = await getUserTeam(req.user.id);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const roleFilter = req.query.role || 'all';
    const deptFilter = req.query.department || 'all';
    const sortBy = req.query.sort || 'name_asc';

    let query = supabaseAdmin
      .from('team_members')
      .select('*', { count: 'exact' })
      .eq('team_id', team.id);

    if (roleFilter !== 'all') query = query.eq('role', roleFilter);
    if (deptFilter !== 'all') query = query.eq('department', deptFilter);
    if (search) query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);

    const sortMap = {
      name_asc: { column: 'name', ascending: true },
      name_desc: { column: 'name', ascending: false },
      spend_desc: { column: 'spend_this_month', ascending: false },
      sessions_desc: { column: 'sessions_this_month', ascending: false },
      recent: { column: 'last_active', ascending: false },
    };
    const sort = sortMap[sortBy] || sortMap.name_asc;
    query = query.order(sort.column, { ascending: sort.ascending });

    const { data, error, count } = await query.range(offset, offset + limit - 1);
    if (error) throw error;

    const totalPages = Math.ceil((count || 0) / limit);
    res.json({ members: data || [], totalPages, totalCount: count || 0 });
  } catch (err) {
    logger.error({ err }, 'Team members error');
    res.status(500).json({ error: 'Failed to load members' });
  }
});

// GET /v1/teams/me/stats
router.get('/teams/me/stats', requireAuth, async (req, res) => {
  try {
    const team = await getUserTeam(req.user.id);
    const { count: activeMembers } = await supabaseAdmin
      .from('team_members')
      .select('*', { count: 'exact', head: true })
      .eq('team_id', team.id)
      .eq('status', 'active');

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const { data: sessions } = await supabaseAdmin
      .from('sessions')
      .select('cost')
      .eq('team_id', team.id)
      .gte('created_at', startOfMonth.toISOString());

    const monthlySpend = (sessions || []).reduce((sum, s) => sum + (s.cost || 0), 0);
    const totalSessions = sessions?.length || 0;

    res.json({
      monthlySpend,
      totalSessions,
      activeMembers: activeMembers || 0,
    });
  } catch (err) {
    logger.error({ err }, 'Team stats error');
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// POST /v1/teams/me/invitations
router.post('/teams/me/invitations', requireAuth, async (req, res) => {
  try {
    const { email, role, department } = req.body;
    const team = await getUserTeam(req.user.id);

    const { count: memberCount } = await supabaseAdmin
      .from('team_members')
      .select('*', { count: 'exact', head: true })
      .eq('team_id', team.id);

    if (memberCount >= team.seats) {
      return res.status(400).json({ error: 'Team is at capacity' });
    }

    const { data, error } = await supabaseAdmin
      .from('team_invitations')
      .insert({
        team_id: team.id,
        email,
        role: role || 'member',
        department: department || null,
        status: 'invited',
        token: generateToken(),
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ invitation: data });
  } catch (err) {
    logger.error({ err }, 'Invite error');
    res.status(500).json({ error: 'Failed to send invite' });
  }
});

// DELETE /v1/teams/me/members/:id
router.delete('/teams/me/members/:id', requireAuth, async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('team_members')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Remove member error');
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

// PUT /v1/teams/me/members/:id/role
router.put('/teams/me/members/:id/role', requireAuth, async (req, res) => {
  try {
    const { role } = req.body;
    const { data, error } = await supabaseAdmin
      .from('team_members')
      .update({ role })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ member: data });
  } catch (err) {
    logger.error({ err }, 'Role update error');
    res.status(500).json({ error: 'Failed to update role' });
  }
});

// PUT /v1/teams/me/members/:id/department
router.put('/teams/me/members/:id/department', requireAuth, async (req, res) => {
  try {
    const { department } = req.body;
    const { data, error } = await supabaseAdmin
      .from('team_members')
      .update({ department })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ member: data });
  } catch (err) {
    logger.error({ err }, 'Department update error');
    res.status(500).json({ error: 'Failed to update department' });
  }
});

// POST /v1/teams/me/invitations/:id/resend
router.post('/teams/me/invitations/:id/resend', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('team_invitations')
      .update({
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ invitation: data });
  } catch (err) {
    logger.error({ err }, 'Resend invite error');
    res.status(500).json({ error: 'Failed to resend invitation' });
  }
});

// GET /v1/teams/me/invite-link
router.get('/teams/me/invite-link', requireAuth, async (req, res) => {
  try {
    const team = await getUserTeam(req.user.id);
    const { data, error } = await supabaseAdmin
      .from('team_invite_links')
      .select('*')
      .eq('team_id', team.id)
      .single();

    if (error || !data) {
      const { data: newLink, error: createErr } = await supabaseAdmin
        .from('team_invite_links')
        .insert({
          team_id: team.id,
          url: `${process.env.CLIENT_URL || 'https://lingobridge-client.vercel.app'}/join-team?token=${generateToken()}`,
          expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .select()
        .single();

      if (createErr) throw createErr;
      return res.json({ url: newLink.url, expiresAt: newLink.expires_at });
    }

    res.json({ url: data.url, expiresAt: data.expires_at });
  } catch (err) {
    logger.error({ err }, 'Invite link error');
    res.status(500).json({ error: 'Failed to load invite link' });
  }
});

// POST /v1/teams/me/invite-link/regenerate
router.post('/teams/me/invite-link/regenerate', requireAuth, async (req, res) => {
  try {
    const team = await getUserTeam(req.user.id);
    const { data, error } = await supabaseAdmin
      .from('team_invite_links')
      .upsert({
        team_id: team.id,
        url: `${process.env.CLIENT_URL || 'https://lingobridge-client.vercel.app'}/join-team?token=${crypto.randomUUID()}`,
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ url: data.url, expiresAt: data.expires_at });
  } catch (err) {
    logger.error({ err }, 'Regenerate link error');
    res.status(500).json({ error: 'Failed to regenerate link' });
  }
});

// GET /v1/teams/me/export
router.get('/teams/me/export', requireAuth, async (req, res) => {
  try {
    const team = await getUserTeam(req.user.id);
    const { data, error } = await supabaseAdmin
      .from('team_members')
      .select('*')
      .eq('team_id', team.id);

    if (error) throw error;

    const format = req.query.format || 'csv';
    if (format === 'csv') {
      const headers = ['Name', 'Email', 'Role', 'Department', 'Status', 'Sessions', 'Spend'];
      const rows = (data || []).map(m => [
        m.name, m.email, m.role, m.department, m.status,
        m.sessions_this_month || 0, m.spend_this_month || 0
      ].join(','));
      const csv = [headers.join(','), ...rows].join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="team-members.csv"');
      return res.send(csv);
    }

    res.json({ members: data || [] });
  } catch (err) {
    logger.error({ err }, 'Export error');
    res.status(500).json({ error: 'Failed to export' });
  }
});

export default router;