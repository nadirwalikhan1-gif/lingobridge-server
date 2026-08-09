// routes/admin.mjs
import { Router } from 'express';
import { supabaseAdmin, verifySupabaseToken } from '../config/supabase.mjs';
import { creditWallet } from '../db/walletRepo.mjs';
import { insertTransaction } from '../db/transactionRepo.mjs';
import { logger } from '../config/logger.mjs';
import { getSupportTickets } from '../db/supportTicketRepo.mjs';

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
        id:        u.id,
        name:      u.full_name || 'Unknown',
        email:     u.email,
        initials:  initials(u.full_name),
        role,
        status:    statusMap[u.id] || 'active',
        joined:    new Date(u.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        createdAt: u.created_at, // FIX: raw timestamp — 'joined' above is pre-formatted for display, this is for stat computation (e.g. new signups this week)
        sessions:  role === 'interpreter' ? (interpreterCountMap[u.id] || 0) : (clientCountMap[u.id] || 0),
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

// ── GET /users/:id ────────────────────────────────────────────────────────────
// FIX: "View" on the admin Users page had no onClick at all — new route.
// Reuses the exact same three sources the list route above already reads
// from (public users table, Auth admin API for real role/status, and the
// transactions ledger for real spend), just scoped to one user via
// auth.admin.getUserById() instead of listing up to 1000 accounts. Session
// count and client spend use identical logic to the list route above, so
// the numbers shown here always match what the list already displays —
// this only adds detail the list doesn't have room for (phone,
// organization, and interpreter earnings, which the list route
// deliberately omits for non-clients).
router.get('/users/:id', requireAdmin, async (req, res) => {
  try {
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('id, full_name, email, phone, created_at, currency, profile_extra')
      .eq('id', req.params.id)
      .single();
    if (error || !user) return res.status(404).json({ error: 'User not found' });

    const { data: authData } = await supabaseAdmin.auth.admin.getUserById(req.params.id);
    const authUser = authData?.user;
    const role   = authUser?.app_metadata?.role || authUser?.user_metadata?.role || 'client';
    const status = authUser?.user_metadata?.status || 'active';

    const { data: sessions } = await supabaseAdmin
      .from('sessions')
      .select('id')
      .eq(role === 'interpreter' ? 'interpreter_id' : 'client_id', req.params.id);

    // Spend (client) vs earnings (interpreter) — same transactions-ledger
    // pattern as the list route's 'spent' column above.
    const { data: txns } = await supabaseAdmin
      .from('transactions')
      .select('amount')
      .eq('user_id', req.params.id)
      .eq('vault_type', role === 'interpreter' ? 'interpreter' : 'client');
    const totalAmount = (txns || []).reduce((sum, t) => sum + Math.abs(Number(t.amount || 0)), 0);

    res.json({
      id:           user.id,
      name:         user.full_name || 'Unknown',
      email:        user.email || '',
      initials:     initials(user.full_name),
      phone:        user.phone || '',
      role,
      status,
      currency:     user.currency || 'USD',
      organization: user.profile_extra?.organization ?? '',
      jobTitle:     user.profile_extra?.jobTitle ?? '',
      joined:       new Date(user.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      sessionsCount: sessions?.length || 0,
      totalAmount,   // spent if client, earned if interpreter — label using `role` client-side
    });
  } catch (err) {
    logger.error({ err, id: req.params.id }, 'Admin user detail error');
    res.status(500).json({ error: 'Failed to load user' });
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
    // FIX: was single-email only, called from a raw window.prompt() dialog
    // with failures silently swallowed into console.error — completely
    // impractical for onboarding hundreds of interpreters, and any real
    // failure (e.g. hitting Supabase's email rate limit) gave the admin no
    // indication anything went wrong. Now accepts either a single email or
    // an array, and returns a per-email result so partial failures are
    // actually visible rather than hidden.
    const { emails: rawEmails, email, role = 'interpreter' } = req.body;
    const emails = rawEmails ?? (email ? [email] : []);

    if (!Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: 'Provide "email" (string) or "emails" (array)' });
    }
    // Sane upper bound per request — bulk-invite hundreds via a few
    // requests rather than one massive one, partly to keep each request
    // fast, partly because Supabase's own email sending rate limit means a
    // single huge batch would mostly fail anyway (see the rate-limit note
    // this endpoint's caller should already be aware of).
    if (emails.length > 50) {
      return res.status(400).json({ error: 'Max 50 emails per request — split into batches' });
    }

    const ALLOWED_INVITE_ROLES = ['interpreter', 'client'];
    if (!ALLOWED_INVITE_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${ALLOWED_INVITE_ROLES.join(', ')}` });
    }

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const results = [];

    for (const rawEmail of emails) {
      const trimmed = typeof rawEmail === 'string' ? rawEmail.trim() : '';
      if (!emailPattern.test(trimmed)) {
        results.push({ email: rawEmail, ok: false, error: 'Invalid email format' });
        continue;
      }
      try {
        // FIX: no redirectTo meant Supabase fell back to the project's
        // default Site URL, landing the invited interpreter on '/' with a
        // session already active and no page to prompt them for a
        // password (see AcceptInvitePage.jsx). Sending them to
        // /accept-invite explicitly closes that gap.
        // Reads FRONTEND_URL first since that's what's actually set on
        // Railway; CLIENT_URL kept as a fallback name since v1.mjs
        // elsewhere in this codebase uses that instead.
        const redirectTo = `${process.env.FRONTEND_URL || process.env.CLIENT_URL || 'https://andiraw.vercel.app'}/accept-invite`;
        const { error } = await supabaseAdmin.auth.admin.inviteUserByEmail(trimmed, { data: { role }, redirectTo });
        if (error) throw error;
        results.push({ email: trimmed, ok: true });
      } catch (err) {
        // Surface Supabase's actual error message (e.g. rate limit) rather
        // than a generic failure, since that's exactly the kind of thing
        // an admin needs to see to know why a batch partially failed.
        results.push({ email: trimmed, ok: false, error: err.message || 'Failed to send invite' });
        logger.warn({ err, email: trimmed }, 'Invite failed for one recipient');
      }
    }

    const succeeded = results.filter(r => r.ok).length;
    res.json({ succeeded, failed: results.length - succeeded, results });
  } catch (err) {
    logger.error({ err }, 'Bulk invite error');
    res.status(500).json({ error: 'Failed to process invites' });
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
      langs:       i.languages || [], // FIX: Interpreters.jsx page reads `langs`, not `languages` — kept both keys so nothing else that relies on `languages` breaks.
      rating:      i.rating || 0,
      isAvailable: i.is_available,
      isVerified:  i.is_verified,
      // FIX: this endpoint never returned a `status` field at all, but
      // Interpreters.jsx does `STATUS_CFG[i.status]` and then reads `.dot`
      // off the result with no guard — i.status was always undefined,
      // STATUS_CFG[undefined] was always undefined, and `.dot` on that
      // crashed the whole page on every single interpreter. This derives
      // the two states we can actually know from this table. Note: this
      // can't distinguish "online but not currently in a call" from "busy
      // in an active session" — that would need a join against active
      // sessions, which isn't available here. For now available → online,
      // anything else → offline; upgrade to a real 'busy' state once
      // there's a live-session signal to check against (e.g. the same
      // source InterpreterPresence.jsx on the dashboard uses).
      status:      i.is_available ? 'online' : 'offline',
      joined:      new Date(i.users?.created_at || i.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    })));
  } catch (err) {
    logger.error({ err }, 'Admin interpreters error');
    res.status(500).json({ error: 'Failed to load interpreters' });
  }
});

// ── GET /interpreters/:id ─────────────────────────────────────────────────────
// FIX: "View" on the admin Interpreters page had no onClick at all — new
// route. Built as a safe extension of the list route above — identical
// select('*', users(...)) wildcard (can't fail on a missing named column,
// unlike a hand-picked field list), scoped to one interpreter. Certification
// file paths are resolved to short-lived signed URLs the same way
// GET /certifications/pending below already does, so an admin can review a
// document directly from this view too.
router.get('/interpreters/:id', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('interpreters')
      .select('*, users(full_name, email, created_at)')
      .eq('user_id', req.params.id)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Interpreter not found' });

    const { data: sessions } = await supabaseAdmin
      .from('sessions')
      .select('id')
      .eq('interpreter_id', req.params.id);

    const { data: txns } = await supabaseAdmin
      .from('transactions')
      .select('amount')
      .eq('user_id', req.params.id)
      .eq('vault_type', 'interpreter');
    const totalEarned = (txns || []).reduce((sum, t) => sum + Number(t.amount || 0), 0);

    // Signed URLs for any certification that has a proof file attached —
    // same 1hr expiry as the existing certification review queue below.
    const certifications = await Promise.all(
      (data.certifications || []).map(async (c) => {
        if (!c.filePath) return { name: c.name, verified: c.verified, fileUrl: null };
        const { data: signed } = await supabaseAdmin.storage
          .from('certification-docs')
          .createSignedUrl(c.filePath, 3600);
        return { name: c.name, verified: c.verified, fileUrl: signed?.signedUrl ?? null };
      })
    );

    res.json({
      id:              data.user_id,
      name:            data.users?.full_name || 'Unknown',
      email:           data.users?.email || '',
      initials:        initials(data.users?.full_name),
      languages:       data.languages || [],
      bio:             data.bio || '',
      rating:          data.rating || 0,
      ratePerMin:      data.price_per_minute || null,
      isAvailable:     data.is_available,
      isVerified:      data.is_verified,
      status:          data.is_available ? 'online' : 'offline',
      certifications,
      specialties:     data.specialties || [],
      yearsExperience: data.years_experience || 0,
      joined:          new Date(data.users?.created_at || data.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      sessionsCount:   sessions?.length || 0,
      totalEarned,
    });
  } catch (err) {
    logger.error({ err, id: req.params.id }, 'Admin interpreter detail error');
    res.status(500).json({ error: 'Failed to load interpreter' });
  }
});

// ── Certification review queue ───────────────────────────────────────────────
// FIX: new — closes the loop opened by the certification proof-upload
// feature (migration-certification-proof-docs.sql). Certifications with an
// attached document always start as verified:false; without this queue
// there was no way for an admin to actually review them, so no
// certification could ever earn its verified badge.
router.get('/certifications/pending', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('interpreters')
      .select('user_id, certifications, users(full_name, email)')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const pending = [];
    for (const interp of data || []) {
      for (const cert of interp.certifications || []) {
        // Only certs with an actual proof document attached and not yet
        // verified belong in the queue — a cert with no filePath has
        // nothing for an admin to review.
        if (cert.filePath && !cert.verified) {
          let signedUrl = null;
          const { data: signed, error: signErr } = await supabaseAdmin.storage
            .from('certification-docs')
            .createSignedUrl(cert.filePath, 3600);
          if (signErr) {
            logger.error({ err: signErr, filePath: cert.filePath }, 'Failed to sign cert doc for admin review');
          } else {
            signedUrl = signed.signedUrl;
          }

          pending.push({
            interpreterId: interp.user_id,
            interpreterName: interp.users?.full_name || 'Unknown',
            interpreterEmail: interp.users?.email || '',
            certName: cert.name,
            filePath: cert.filePath,
            documentUrl: signedUrl,
          });
        }
      }
    }

    res.json({ pending });
  } catch (err) {
    logger.error({ err }, 'Certification review queue error');
    res.status(500).json({ error: 'Failed to load certification review queue' });
  }
});

router.post('/certifications/review', requireAdmin, async (req, res) => {
  try {
    const { interpreterId, filePath, approve } = req.body;
    if (!interpreterId || !filePath || typeof approve !== 'boolean') {
      return res.status(400).json({ error: 'interpreterId, filePath, and approve (boolean) are required' });
    }

    const { data: interp, error: fetchErr } = await supabaseAdmin
      .from('interpreters')
      .select('certifications, is_verified')
      .eq('user_id', interpreterId)
      .single();
    if (fetchErr || !interp) return res.status(404).json({ error: 'Interpreter not found' });

    // FIX: reject removes the certification entirely rather than leaving it
    // sitting at verified:false forever — an admin explicitly rejecting a
    // document means it wasn't valid proof, so it shouldn't linger on the
    // interpreter's profile implying it's still "pending". They can always
    // re-add and re-upload if it was a mistake.
    const updated = approve
      ? (interp.certifications || []).map(c => c.filePath === filePath ? { ...c, verified: true } : c)
      : (interp.certifications || []).filter(c => c.filePath !== filePath);

    // FIX: approving a certification should mean something bigger than the
    // cert chip alone — it should earn the interpreter their overall
    // "Verified by Andiraw" badge (is_verified), which is what actually
    // shows next to their name on the profile and client-facing cards.
    // Only auto-GRANTS on approval; a reject never auto-revokes is_verified,
    // since that flag may reflect other admin judgment beyond this one
    // certification (e.g. background check, manual review) — revoking it
    // stays a deliberate separate admin action, not a side effect of
    // rejecting one document.
    const patch = { certifications: updated };
    if (approve && !interp.is_verified) patch.is_verified = true;

    const { error: updateErr } = await supabaseAdmin
      .from('interpreters')
      .update(patch)
      .eq('user_id', interpreterId);
    if (updateErr) throw updateErr;

    logger.info({ interpreterId, filePath, approve, adminId: req.user.id }, 'Certification reviewed');
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'Certification review action error');
    res.status(500).json({ error: 'Failed to review certification' });
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

// ── Support Tickets ─────────────────────────────────────────────────────────
// GET /v1/admin/support-tickets
// NEW — this is what "any option on the client dashboard meant to reach
// admin should work" actually needed on the admin side. Every ticket
// created via the contact form, account deletion request, BAA request, or
// review report lands here — same shared support_tickets table, same
// createSupportTicket() function on the writing end. Resolve/reopen are
// socket-only (admin-resolve-support-ticket / admin-reopen-support-ticket
// in socket/handlers/adminHandler.mjs) — matching Disputes.jsx's own
// established pattern of REST for the initial list, socket for mutations,
// rather than building two separate paths to do the same thing.
router.get('/support-tickets', requireAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    const tickets = await getSupportTickets({ status });
    res.json(tickets);
  } catch (err) {
    logger.error({ err }, 'Admin support tickets fetch error');
    res.json([]);
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
