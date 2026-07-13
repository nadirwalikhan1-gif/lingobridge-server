import adminRouter from './admin.mjs';
import { Router } from 'express';
import multer from 'multer';
import { supabaseAdmin, verifySupabaseToken } from '../config/supabase.mjs';
import { getSessionsByUser } from '../db/sessionRepo.mjs';
import { getAvailableBalance } from '../db/walletRepo.mjs';
import { createSupportTicket } from '../db/supportTicketRepo.mjs';
import { sendEmail } from '../services/notificationService.mjs';
import { logger } from '../config/logger.mjs';

const router = Router();

// In-memory storage — files are small (avatars) and immediately streamed to
// Supabase Storage, never written to local disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, or WebP images are allowed'));
    }
    cb(null, true);
  },
});

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

// ── GET /v1/dashboard ─────────────────────────────────────────────────────────
// Single endpoint returning all client dashboard data in one round trip.
// Replaces 5 separate calls: stats, recent sessions, upcoming, activity, wallet.
router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const startOfMonthISO = startOfMonth.toISOString();
    const nowISO = new Date().toISOString();

    const [
      { count: totalSessions },
      { count: monthSessions },
      { count: favourites },
      { data: txData },
      walletResult,
      recentSessions,
      { data: upcomingSessions },
      { data: activityData },
    ] = await Promise.all([
      supabaseAdmin.from('sessions').select('*', { count: 'exact', head: true }).eq('client_id', userId),
      supabaseAdmin.from('sessions').select('*', { count: 'exact', head: true }).eq('client_id', userId).gte('created_at', startOfMonthISO),
      supabaseAdmin.from('favorites').select('*', { count: 'exact', head: true }).eq('client_id', userId),
      supabaseAdmin.from('transactions').select('amount').eq('user_id', userId).eq('type', 'debit').gte('created_at', startOfMonthISO),
      getAvailableBalance(userId, 'client').catch(() => ({ availableBalance: 0, reservedBalance: 0, balance: 0, currency: 'USD' })),
      getSessionsByUser(userId, 5, 0).catch(() => []),
      supabaseAdmin.from('sessions').select('*').eq('client_id', userId).eq('status', 'scheduled').gte('scheduled_at', nowISO).order('scheduled_at', { ascending: true }).limit(5),
      supabaseAdmin.from('transactions').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(10),
    ]);

    const monthDebits = (txData || []).reduce((sum, t) => sum + Math.abs(t.amount), 0);

    res.json({
      stats: {
        totalSessions: totalSessions || 0,
        monthSessions: monthSessions || 0,
        favourites: favourites || 0,
        walletBalance: walletResult?.availableBalance ?? 0,
        monthDebits,
        sessionsTrend: `${monthSessions || 0} this month`,
        favouritesTrend: '+0 new',
      },
      sessions: recentSessions || [],
      upcoming: upcomingSessions || [],
      activities: activityData || [],
      wallet: {
        available: walletResult?.availableBalance ?? 0,
        reserved: walletResult?.reservedBalance ?? 0,
        balance: walletResult?.balance ?? 0,
        currency: walletResult?.currency ?? 'USD',
        spentToday: 0,
        spentWeek: 0,
        spentMonth: monthDebits,
      },
    });
  } catch (err) {
    logger.error({ err }, 'Dashboard combined error');
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// ── GET /v1/dashboard/stats ────────────────────────────────────────────────────
router.get('/dashboard/stats', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const startOfMonthISO = startOfMonth.toISOString();

    // Run all queries in parallel — cuts response time from ~500ms to ~150ms
    const [
      { count: totalSessions },
      { count: monthSessions },
      { count: favourites },
      { data: txData },
      walletResult,
    ] = await Promise.all([
      supabaseAdmin.from('sessions').select('*', { count: 'exact', head: true }).eq('client_id', userId),
      supabaseAdmin.from('sessions').select('*', { count: 'exact', head: true }).eq('client_id', userId).gte('created_at', startOfMonthISO),
      supabaseAdmin.from('favorites').select('*', { count: 'exact', head: true }).eq('client_id', userId),
      supabaseAdmin.from('transactions').select('amount').eq('user_id', userId).eq('type', 'debit').gte('created_at', startOfMonthISO),
      getAvailableBalance(userId, 'client').catch(() => ({ availableBalance: 0 })),
    ]);

    const monthDebits = (txData || []).reduce((sum, t) => sum + Math.abs(t.amount), 0);

    res.json({
      totalSessions: totalSessions || 0,
      monthSessions: monthSessions || 0,
      favourites: favourites || 0,
      walletBalance: walletResult?.availableBalance ?? 0,
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

    // FIX: was querying 'interpreter_profiles', which does not exist anywhere
    // in this schema — every other part of the backend (interpreterRepo.mjs,
    // admin.mjs, registerHandler.mjs) uses 'interpreters'. This endpoint has
    // likely never returned real data, which is why the client booking flow
    // ended up with a hardcoded interpreter list instead.
    // FIX: added years_experience, certifications, specialties, is_verified
    // (was already selected, now also mapped through) — needed for the
    // trust-building profile rebuild. Select list stays intentionally
    // narrow rather than 'select(*)' so the compact card payload doesn't
    // balloon; the full detail endpoint below fetches everything.
    let query = supabaseAdmin
      .from('interpreters')
      .select('user_id, languages, rating, price_per_minute, bio, is_verified, is_available, years_experience, specialties, users(full_name, avatar_url)')
      .eq('is_available', true)
      .eq('is_verified', true);

    if (language) query = query.contains('languages', [language]);
    // NOTE: no 'category'/'specializations' column exists on interpreters —
    // category is a per-session attribute (see CategoryGrid.jsx), not a
    // fixed per-interpreter specialty, so that filter is intentionally
    // not applied here rather than silently faked.

    const { data, error } = await query.order('rating', { ascending: false }).limit(20);
    if (error) throw error;

    const interpreters = (data || []).map((i) => ({
      id:              i.user_id,
      name:            i.users?.full_name ?? 'Unknown',
      avatar:          i.users?.avatar_url ?? null,
      languages:       i.languages || [],
      rating:          i.rating || 0,
      bio:             i.bio || '',
      verified:        i.is_verified,
      online:          i.is_available,
      ratePerMin:      i.price_per_minute || null,
      yearsExperience: i.years_experience || 0,
      specialties:     i.specialties || [],
    }));

    res.json({ interpreters });
  } catch (err) {
    logger.error({ err }, 'Interpreters error');
    res.json({ interpreters: [] });
  }
});

// ── GET /v1/interpreters/:id ─────────────────────────────────────────────────
// FIX: new endpoint — powers the "View full profile" detail view on client
// booking cards (InterpreterProfileModal.jsx). The compact list above
// intentionally omits certifications and full bio length to keep the list
// payload small; this fetches the complete profile for one interpreter.
router.get('/interpreters/:id', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('interpreters')
      .select('user_id, languages, rating, price_per_minute, bio, is_verified, is_available, years_experience, certifications, specialties, users(full_name, avatar_url, created_at)')
      .eq('user_id', req.params.id)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Interpreter not found' });

    res.json({
      id:              data.user_id,
      name:            data.users?.full_name ?? 'Unknown',
      avatar:          data.users?.avatar_url ?? null,
      languages:       data.languages || [],
      rating:          data.rating || 0,
      bio:             data.bio || '',
      verified:        data.is_verified,
      online:          data.is_available,
      ratePerMin:      data.price_per_minute || null,
      yearsExperience: data.years_experience || 0,
      // FIX: never send filePath to a client-facing endpoint — it's a
      // private storage path to a personal document (see
      // migration-certification-proof-docs.sql). Only the certification
      // name and whether an admin has verified it are ever public.
      certifications:  (data.certifications || []).map(c => ({ name: c.name, verified: c.verified })),
      specialties:     data.specialties || [],
      memberSince:     data.users?.created_at ?? null,
    });
  } catch (err) {
    logger.error({ err, id: req.params.id }, 'Interpreter detail error');
    res.status(500).json({ error: 'Failed to load interpreter profile' });
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
// Helper: get or create team for user
async function getUserTeam(userId) {
  try {
    // Use .limit(1) instead of .single() to avoid "multiple rows" error
    const { data: teams, error: fetchError } = await supabaseAdmin
      .from('teams')
      .select('*')
      .eq('owner_id', userId)
      .limit(1);

    if (fetchError) {
      console.error('🔥 Fetch team error:', fetchError.message);
      throw fetchError;
    }

    if (teams && teams.length > 0) {
      return teams[0];
    }

    // No team exists — create one
    console.log('🆕 Creating new team for user:', userId);
    
    const { data: inserted, error: createError } = await supabaseAdmin
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
      .select();

    if (createError) {
      console.error('🔥 Create team error:', createError.message);
      throw createError;
    }

    if (!inserted || inserted.length === 0) {
      throw new Error('Team insert returned no rows');
    }

    return inserted[0];
  } catch (err) {
    console.error('🔥 getUserTeam FAILED:', err.message, err.code);
    throw err;
  }
}

// GET /v1/teams/me
router.get('/teams/me', requireAuth, async (req, res) => {
  try {
    const team = await getUserTeam(req.user.id);
   res.json({
  data: {
    id: team.id,
    name: team.name,
    plan: team.plan,
    seats: team.seats,
    departments: team.departments || [],
    rates: team.rates || { video: 1.79, audio: 1.49 },
    billingCycle: team.billing_cycle,
    nextInvoice: team.next_invoice,
  }
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
    res.json({
  data: { members: data || [], totalPages, totalCount: count || 0 }
});
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
  data: {
    monthlySpend,
    totalSessions,
    activeMembers: activeMembers || 0,
  }
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
    // FIX (IDOR): previously deleted by id alone, with no check that the
    // target member belonged to the caller's own team — any authenticated
    // user who obtained another team's member id could delete it. Scoped to
    // team_id now, matching the pattern already used correctly elsewhere in
    // this file (see POST /teams/me/invitations above).
    const team = await getUserTeam(req.user.id);

    const { data, error } = await supabaseAdmin
      .from('team_members')
      .delete()
      .eq('id', req.params.id)
      .eq('team_id', team.id)
      .select();

    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Member not found in your team' });
    }

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Remove member error');
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

// PUT /v1/teams/me/members/:id/role
router.put('/teams/me/members/:id/role', requireAuth, async (req, res) => {
  try {
    // FIX (IDOR): same class of bug as DELETE above — scoped to the
    // caller's own team so role changes can't reach another team's members.
    const { role } = req.body;
    const team = await getUserTeam(req.user.id);

    const { data, error } = await supabaseAdmin
      .from('team_members')
      .update({ role })
      .eq('id', req.params.id)
      .eq('team_id', team.id)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ error: 'Member not found in your team' });
    }

    res.json({ member: data });
  } catch (err) {
    logger.error({ err }, 'Role update error');
    res.status(500).json({ error: 'Failed to update role' });
  }
});

// PUT /v1/teams/me/members/:id/department
router.put('/teams/me/members/:id/department', requireAuth, async (req, res) => {
  try {
    // FIX (IDOR): same class of bug as DELETE above — scoped to the
    // caller's own team.
    const { department } = req.body;
    const team = await getUserTeam(req.user.id);

    const { data, error } = await supabaseAdmin
      .from('team_members')
      .update({ department })
      .eq('id', req.params.id)
      .eq('team_id', team.id)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ error: 'Member not found in your team' });
    }

    res.json({ member: data });
  } catch (err) {
    logger.error({ err }, 'Department update error');
    res.status(500).json({ error: 'Failed to update department' });
  }
});

// POST /v1/teams/me/invitations/:id/resend
router.post('/teams/me/invitations/:id/resend', requireAuth, async (req, res) => {
  try {
    // FIX (IDOR): same class of bug as DELETE above — scoped to the
    // caller's own team so invitations can't be resent/extended for a
    // different team's pending invite.
    const team = await getUserTeam(req.user.id);

    const { data, error } = await supabaseAdmin
      .from('team_invitations')
      .update({
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .eq('id', req.params.id)
      .eq('team_id', team.id)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ error: 'Invitation not found in your team' });
    }

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
      return res.json({
  data: { url: data.url, expiresAt: data.expires_at }
});
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
// ── GET /v1/users/me/profile ───────────────────────────────────────────────────
router.get('/users/me/profile', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('full_name, email, phone, avatar_url, profile_extra')
      .eq('id', req.user.id)
      .single();

    if (error) throw error;

    const [firstName = '', lastName = ''] = (data.full_name ?? '').split(' ', 2);
    const extra = data.profile_extra ?? {};

    res.json({
      data: {
        firstName,
        lastName,
        email:        data.email ?? '',
        phone:        data.phone ?? '',
        avatar:       data.avatar_url ?? null,
        organization: extra.organization ?? '',
        jobTitle:     extra.jobTitle ?? '',
        industry:     extra.industry ?? '',
        timezone:     extra.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        bio:          extra.bio ?? '',
      }
    });
  } catch (err) {
    logger.error({ err, userId: req.user.id }, 'Get profile failed');
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// ── PUT /v1/users/me/profile ───────────────────────────────────────────────────
router.put('/users/me/profile', requireAuth, async (req, res) => {
  try {
    const { firstName, lastName, email, phone, organization, jobTitle, industry, timezone, bio } = req.body;

    if (!firstName?.trim() || !lastName?.trim()) {
      return res.status(400).json({ error: 'First and last name are required' });
    }

    const { data, error } = await supabaseAdmin
      .from('users')
      .update({
        full_name: `${firstName.trim()} ${lastName.trim()}`,
        email:     email ?? undefined,
        phone:     phone ?? undefined,
        profile_extra: { organization, jobTitle, industry, timezone, bio },
      })
      .eq('id', req.user.id)
      .select('full_name, email, phone, avatar_url, profile_extra')
      .single();

    if (error) throw error;

    logger.info({ userId: req.user.id }, 'Profile updated');
    res.json({ success: true, data });
  } catch (err) {
    logger.error({ err, userId: req.user.id }, 'Update profile failed');
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ── GET /v1/users/me/settings ──────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  theme:                            'light',
  language:                         'en',
  currency:                         'USD',
  timezone:                         Intl.DateTimeFormat().resolvedOptions().timeZone,
  dateFormat:                       'MM/DD/YYYY',
  defaultSessionType:               'video',
  defaultDuration:                  30,
  preferredGender:                  'no_preference',
  requireInterpreterCertification:  false,
  autoRecord:                       false,
  autoInvoice:                      true,
  billingEmail:                     '',
  invoiceFormat:                    'pdf',
  paymentMethod:                    'wallet',
  highContrast:                     false,
  reduceMotion:                     false,
  screenReader:                     false,
};

router.get('/users/me/settings', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('settings')
      .eq('id', req.user.id)
      .single();

    if (error) throw error;

    res.json({ data: { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) } });
  } catch (err) {
    logger.error({ err, userId: req.user.id }, 'Get settings failed');
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// ── PUT /v1/users/me/settings ──────────────────────────────────────────────────
router.put('/users/me/settings', requireAuth, async (req, res) => {
  try {
    const { data: existing } = await supabaseAdmin
      .from('users')
      .select('settings')
      .eq('id', req.user.id)
      .single();

    const merged = { ...DEFAULT_SETTINGS, ...(existing?.settings ?? {}), ...req.body };

    const { error } = await supabaseAdmin
      .from('users')
      .update({ settings: merged })
      .eq('id', req.user.id);

    if (error) throw error;

    logger.info({ userId: req.user.id }, 'Settings updated');
    res.json({ success: true, data: merged });
  } catch (err) {
    logger.error({ err, userId: req.user.id }, 'Update settings failed');
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ── POST /v1/users/me/avatar ───────────────────────────────────────────────────
// Requires a public Supabase Storage bucket named "avatars" to exist.
// Create it once in the Supabase dashboard: Storage → New bucket → "avatars" → Public.
router.post('/users/me/avatar', requireAuth, upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const ext = req.file.originalname.split('.').pop() || 'jpg';
    const path = `${req.user.id}/avatar.${ext}`;

    const { error: uploadErr } = await supabaseAdmin.storage
      .from('avatars')
      .upload(path, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true,
      });

    if (uploadErr) throw uploadErr;

    const { data: urlData } = supabaseAdmin.storage.from('avatars').getPublicUrl(path);
    // Cache-bust so the browser doesn't show the old avatar after re-upload
    const avatarUrl = `${urlData.publicUrl}?v=${Date.now()}`;

    const { error: updateErr } = await supabaseAdmin
      .from('users')
      .update({ avatar_url: avatarUrl })
      .eq('id', req.user.id);

    if (updateErr) throw updateErr;

    logger.info({ userId: req.user.id }, 'Avatar uploaded');
    res.json({ data: { avatar: avatarUrl } });
  } catch (err) {
    logger.error({ err, userId: req.user.id }, 'Avatar upload failed');
    res.status(500).json({ error: err.message || 'Failed to upload avatar' });
  }
});

// FIX: separate multer instance from the avatar one above — certification
// proof documents are commonly PDFs (scanned certificates), not just images.
const uploadCertDoc = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB — scanned certs can be larger than a profile photo
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, WebP, or PDF files are allowed'));
    }
    cb(null, true);
  },
});

// ── POST /v1/interpreters/me/certification-file ──────────────────────────────
// Requires a PRIVATE Supabase Storage bucket named "certification-docs" —
// see migration-certification-proof-docs.sql, which creates it with
// public=false. Unlike the avatar endpoint above, this deliberately does
// NOT return a public URL — certification proof documents are personal
// records (they often contain a full name, license numbers, etc.) and
// should never be reachable by an unauthenticated guess at the file path.
// Returns only the storage path; the frontend then calls
// get-interpreter-profile over the socket to receive a short-lived signed
// URL for actually viewing/downloading it (see
// interpreterDashboardHandler.mjs).
router.post('/interpreters/me/certification-file', requireAuth, uploadCertDoc.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const ext = req.file.originalname.split('.').pop() || 'pdf';
    const path = `${req.user.id}/${Date.now()}.${ext}`;

    const { error: uploadErr } = await supabaseAdmin.storage
      .from('certification-docs')
      .upload(path, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false, // each cert's proof gets its own timestamped path, never overwrite
      });

    if (uploadErr) throw uploadErr;

    logger.info({ userId: req.user.id }, 'Certification document uploaded');
    res.json({ data: { filePath: path } });
  } catch (err) {
    logger.error({ err, userId: req.user.id }, 'Certification document upload failed');
    res.status(500).json({ error: err.message || 'Failed to upload certification document' });
  }
});

// ── PUT /v1/users/me/password ──────────────────────────────────────────────────
router.put('/users/me/password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    // Verify current password by attempting a sign-in — this is the only
    // reliable way to check a password against Supabase Auth without
    // storing it ourselves.
    const { error: signInErr } = await supabaseAdmin.auth.signInWithPassword({
      email:    req.user.email,
      password: currentPassword,
    });

    if (signInErr) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(
      req.user.id,
      { password: newPassword }
    );

    if (updateErr) throw updateErr;

    logger.info({ userId: req.user.id }, 'Password changed');
    res.json({ data: { success: true } });
  } catch (err) {
    logger.error({ err, userId: req.user.id }, 'Password change failed');
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// ── POST /v1/users/me/export ───────────────────────────────────────────────────
// Immediate synchronous export — compiles the user's real data and returns
// it directly so the frontend can download it as a JSON file right away.
router.post('/users/me/export', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const [{ data: profile }, { data: sessions }, { data: transactions }, { data: favourites }] = await Promise.all([
      supabaseAdmin.from('users').select('full_name, email, phone, avatar_url, profile_extra, settings, created_at').eq('id', userId).single(),
      supabaseAdmin.from('sessions').select('id, session_type, language, purpose, status, started_at, ended_at').eq('client_id', userId).order('started_at', { ascending: false }),
      supabaseAdmin.from('transactions').select('id, type, amount, currency, created_at').eq('user_id', userId).order('created_at', { ascending: false }),
      supabaseAdmin.from('favorites').select('interpreter_id, created_at').eq('client_id', userId),
    ]);

    const exportPayload = {
      exportedAt:   new Date().toISOString(),
      profile:      profile ?? null,
      sessions:     sessions ?? [],
      transactions: transactions ?? [],
      favourites:   favourites ?? [],
    };

    logger.info({ userId }, 'Data export generated');
    res.json({ data: exportPayload });
  } catch (err) {
    logger.error({ err, userId: req.user.id }, 'Data export failed');
    res.status(500).json({ error: 'Failed to export data' });
  }
});

// ── POST /v1/users/me/delete-request ───────────────────────────────────────────
// Does NOT delete anything immediately — creates a support ticket for admin
// review, matching how account deletion is presented to the user ("request
// submitted"). Actual deletion should always be a deliberate admin action,
// never an automatic one, given financial/session history implications.
router.post('/users/me/delete-request', requireAuth, async (req, res) => {
  try {
    const { reason } = req.body;

    const ticket = await createSupportTicket({
      userId:  req.user.id,
      role:    'client',
      subject: 'Account Deletion Request',
      message: reason ? `Reason given: ${reason}` : 'No reason given',
    });

    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      await sendEmail(
        adminEmail,
        `Account deletion request — ${req.user.email}`,
        `<p>User <strong>${req.user.email}</strong> (${req.user.id}) has requested account deletion.</p><p>Reason: ${reason || 'Not given'}</p><p>Ticket ID: ${ticket.id}</p>`
      ).catch((err) => logger.error({ err }, 'Delete-request admin email failed'));
    }

    if (req.user.email) {
      await sendEmail(
        req.user.email,
        'Your Andiraw account deletion request',
        `<p>We've received your request to delete your Andiraw account. Our team will process this within a few business days and confirm once complete.</p><p>If you didn't request this, contact support immediately.</p>`
      ).catch((err) => logger.error({ err }, 'Delete-request client email failed'));
    }

    logger.info({ userId: req.user.id, ticketId: ticket.id }, 'Account deletion requested');
    res.json({ data: { success: true, ticketId: ticket.id } });
  } catch (err) {
    logger.error({ err, userId: req.user.id }, 'Delete request failed');
    res.status(500).json({ error: 'Failed to submit deletion request' });
  }
});

// ── POST /v1/users/me/baa-request ──────────────────────────────────────────────
// Business Associate Agreement — a HIPAA compliance document healthcare
// clients need signed before using the platform for medical interpretation.
// Logged as a ticket for admin/legal follow-up, not auto-generated.
router.post('/users/me/baa-request', requireAuth, async (req, res) => {
  try {
    const ticket = await createSupportTicket({
      userId:  req.user.id,
      role:    'client',
      subject: 'BAA Request',
      message: `User ${req.user.email} has requested a Business Associate Agreement.`,
    });

    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      await sendEmail(
        adminEmail,
        `BAA request — ${req.user.email}`,
        `<p>User <strong>${req.user.email}</strong> (${req.user.id}) has requested a BAA.</p><p>Ticket ID: ${ticket.id}</p>`
      ).catch((err) => logger.error({ err }, 'BAA-request admin email failed'));
    }

    if (req.user.email) {
      await sendEmail(
        req.user.email,
        'Your Andiraw BAA request',
        `<p>We've received your request for a Business Associate Agreement. Our team will follow up with the signed document shortly.</p>`
      ).catch((err) => logger.error({ err }, 'BAA-request client email failed'));
    }

    logger.info({ userId: req.user.id, ticketId: ticket.id }, 'BAA requested');
    res.json({ data: { success: true, ticketId: ticket.id } });
  } catch (err) {
    logger.error({ err, userId: req.user.id }, 'BAA request failed');
    res.status(500).json({ error: 'Failed to submit BAA request' });
  }
});

// ── GET /v1/interpreters/search ────────────────────────────────────────────────
// Name/language search used by Messages ("new conversation") and Favourites.
// Separate from GET /interpreters (which filters by language/category/session
// type for the booking flow) since this is a free-text name search.
router.get('/interpreters/search', requireAuth, async (req, res) => {
  try {
    const { q, limit = 20 } = req.query;

    let query = supabaseAdmin
      .from('interpreters')
      .select('user_id, languages, rating, is_verified, users(full_name, avatar_url)')
      .eq('is_available', true);

    const { data, error } = await query.limit(parseInt(limit) || 20);
    if (error) throw error;

    const filtered = q
      ? (data || []).filter(i => (i.users?.full_name ?? '').toLowerCase().includes(q.toLowerCase()))
      : (data || []);

    const interpreters = filtered.map(i => ({
      id:       i.user_id,
      name:     i.users?.full_name ?? 'Unknown',
      avatar:   i.users?.avatar_url ?? null,
      languages: i.languages ?? [],
    }));

    res.json({ data: { interpreters } });
  } catch (err) {
    logger.error({ err }, 'Interpreter search failed');
    res.json({ data: { interpreters: [] } });
  }
});

// ── POST /v1/conversations ─────────────────────────────────────────────────────
// Starts a new conversation, or returns the existing one if the client
// already has a thread with this interpreter (idempotent — avoids duplicate
// threads when clicking "Message" more than once).
router.post('/conversations', requireAuth, async (req, res) => {
  try {
    const { interpreterId } = req.body;
    if (!interpreterId) return res.status(400).json({ error: 'interpreterId is required' });

    const { data: existing } = await supabaseAdmin
      .from('conversations')
      .select('*')
      .eq('client_id', req.user.id)
      .eq('interpreter_id', interpreterId)
      .maybeSingle();

    if (existing) return res.json({ data: existing });

    const { data, error } = await supabaseAdmin
      .from('conversations')
      .insert({ client_id: req.user.id, interpreter_id: interpreterId })
      .select()
      .single();

    if (error) throw error;

    logger.info({ userId: req.user.id, interpreterId, conversationId: data.id }, 'Conversation started');
    res.json({ data });
  } catch (err) {
    logger.error({ err, userId: req.user.id }, 'Start conversation failed');
    res.status(500).json({ error: 'Failed to start conversation' });
  }
});

// ── GET /v1/conversations/:id/messages ─────────────────────────────────────────
router.get('/conversations/:id/messages', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { before, limit = 50 } = req.query;

    // Ownership check — client can only read their own conversation
    const { data: convo } = await supabaseAdmin
      .from('conversations')
      .select('id, client_id')
      .eq('id', id)
      .single();

    if (!convo || convo.client_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to view this conversation' });
    }

    let query = supabaseAdmin
      .from('messages')
      .select('*')
      .eq('conversation_id', id)
      .order('created_at', { ascending: false })
      .limit(parseInt(limit) || 50);

    if (before) query = query.lt('created_at', before);

    const { data, error } = await query;
    if (error) throw error;

    res.json({ data: { messages: (data || []).reverse() } });
  } catch (err) {
    logger.error({ err, conversationId: req.params.id }, 'Fetch messages failed');
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// ── POST /v1/conversations/:id/messages ────────────────────────────────────────
router.post('/conversations/:id/messages', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { text, attachments = [] } = req.body;

    if (!text?.trim() && attachments.length === 0) {
      return res.status(400).json({ error: 'Message cannot be empty' });
    }

    const { data: convo } = await supabaseAdmin
      .from('conversations')
      .select('id, client_id')
      .eq('id', id)
      .single();

    if (!convo || convo.client_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to message in this conversation' });
    }

    const { data, error } = await supabaseAdmin
      .from('messages')
      .insert({
        conversation_id: id,
        sender_id:        req.user.id,
        text:             text ?? '',
        attachments,
        read:             false,
      })
      .select()
      .single();

    if (error) throw error;

    await supabaseAdmin
      .from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', id);

    res.json({ data });
  } catch (err) {
    logger.error({ err, conversationId: req.params.id }, 'Send message failed');
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ── POST /v1/conversations/:id/read ────────────────────────────────────────────
router.post('/conversations/:id/read', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabaseAdmin
      .from('messages')
      .update({ read: true })
      .eq('conversation_id', id)
      .neq('sender_id', req.user.id);

    if (error) throw error;

    res.json({ data: { success: true } });
  } catch (err) {
    logger.error({ err, conversationId: req.params.id }, 'Mark read failed');
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

// ── DELETE /v1/users/me/payment-methods/:id ────────────────────────────────────
router.delete('/users/me/payment-methods/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: method } = await supabaseAdmin
      .from('payment_methods')
      .select('id, user_id')
      .eq('id', id)
      .single();

    if (!method || method.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to remove this payment method' });
    }

    const { error } = await supabaseAdmin.from('payment_methods').delete().eq('id', id);
    if (error) throw error;

    logger.info({ userId: req.user.id, methodId: id }, 'Payment method removed');
    res.json({ data: { success: true } });
  } catch (err) {
    logger.error({ err, userId: req.user.id }, 'Remove payment method failed');
    res.status(500).json({ error: 'Failed to remove payment method' });
  }
});

// ── PUT /v1/users/me/payment-methods/:id/default ───────────────────────────────
router.put('/users/me/payment-methods/:id/default', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: method } = await supabaseAdmin
      .from('payment_methods')
      .select('id, user_id')
      .eq('id', id)
      .single();

    if (!method || method.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to modify this payment method' });
    }

    // Clear existing default, then set the new one — two steps since Supabase
    // doesn't support a single conditional "set all false except this one" update
    await supabaseAdmin
      .from('payment_methods')
      .update({ is_default: false })
      .eq('user_id', req.user.id);

    const { error } = await supabaseAdmin
      .from('payment_methods')
      .update({ is_default: true })
      .eq('id', id);

    if (error) throw error;

    logger.info({ userId: req.user.id, methodId: id }, 'Default payment method updated');
    res.json({ data: { success: true } });
  } catch (err) {
    logger.error({ err, userId: req.user.id }, 'Set default payment method failed');
    res.status(500).json({ error: 'Failed to set default payment method' });
  }
});

// ── POST /v1/reviews/:id/helpful ────────────────────────────────────────────────
router.post('/reviews/:id/helpful', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabaseAdmin.rpc('increment_review_helpful', { review_id: id });

    // Fallback if the RPC function doesn't exist yet — read-modify-write
    if (error) {
      const { data: review } = await supabaseAdmin
        .from('session_ratings')
        .select('helpful_count')
        .eq('id', id)
        .single();

      const newCount = (review?.helpful_count ?? 0) + 1;

      const { error: updateErr } = await supabaseAdmin
        .from('session_ratings')
        .update({ helpful_count: newCount })
        .eq('id', id);

      if (updateErr) throw updateErr;

      return res.json({ data: { success: true, helpfulCount: newCount } });
    }

    res.json({ data: { success: true, helpfulCount: data } });
  } catch (err) {
    logger.error({ err, reviewId: req.params.id }, 'Mark review helpful failed');
    res.status(500).json({ error: 'Failed to mark review as helpful' });
  }
});

// ── POST /v1/reviews/:id/report ─────────────────────────────────────────────────
router.post('/reviews/:id/report', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const ticket = await createSupportTicket({
      userId:  req.user.id,
      role:    'client',
      subject: 'Review Flagged for Report',
      message: `Review ID ${id} reported. Reason: ${reason || 'Not given'}`,
    });

    logger.info({ userId: req.user.id, reviewId: id, ticketId: ticket.id }, 'Review reported');
    res.json({ data: { success: true, ticketId: ticket.id } });
  } catch (err) {
    logger.error({ err, reviewId: req.params.id }, 'Report review failed');
    res.status(500).json({ error: 'Failed to report review' });
  }
});

// ── GET /v1/users/me/sessions ──────────────────────────────────────────────────
// Active login sessions/devices for the security tab. Calls a Postgres
// function since Supabase's JS client has no public API to list individual
// sessions — see migration 20260702_session_management_functions.sql.
router.get('/users/me/sessions', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.rpc('get_user_sessions', { uid: req.user.id });
    if (error) throw error;

    res.json({ data: { sessions: data || [] } });
  } catch (err) {
    logger.error({ err, userId: req.user.id }, 'Get sessions failed');
    res.status(500).json({ error: 'Failed to load active sessions' });
  }
});

// ── DELETE /v1/users/me/sessions/:sessionId ────────────────────────────────────
router.delete('/users/me/sessions/:sessionId', requireAuth, async (req, res) => {
  try {
    const { sessionId } = req.params;

    const { data: revoked, error } = await supabaseAdmin.rpc('revoke_user_session', {
      session_id: sessionId,
      uid:        req.user.id,
    });

    if (error) throw error;
    if (!revoked) return res.status(404).json({ error: 'Session not found' });

    logger.info({ userId: req.user.id, sessionId }, 'Session revoked');
    res.json({ data: { success: true } });
  } catch (err) {
    logger.error({ err, userId: req.user.id, sessionId: req.params.sessionId }, 'Revoke session failed');
    res.status(500).json({ error: 'Failed to revoke session' });
  }
});

// ── POST /v1/sessions/:id/feedback ─────────────────────────────────────────────
// Interpreter's post-call feedback (call quality + flags like "client issue",
// "technical problem") — distinct from the client's rating of the
// interpreter (POST /sessions/:id/rate). No dedicated table for this yet,
// logged as a support ticket for admin visibility, same pattern as
// BAA/delete-request.
router.post('/sessions/:id/feedback', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { callQuality, comment, flags = [] } = req.body;

    const ticket = await createSupportTicket({
      userId:  req.user.id,
      role:    'interpreter',
      subject: 'Post-call feedback',
      message: `Session ${id} — quality: ${callQuality}/5${flags.length ? `, flags: ${flags.join(', ')}` : ''}${comment ? `, comment: ${comment}` : ''}`,
    });

    logger.info({ userId: req.user.id, sessionId: id, ticketId: ticket.id }, 'Interpreter feedback logged');
    res.json({ data: { success: true, ticketId: ticket.id } });
  } catch (err) {
    logger.error({ err, sessionId: req.params.id }, 'Interpreter feedback failed');
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

router.use('/admin', adminRouter);
export default router;