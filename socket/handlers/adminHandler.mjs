// socket/handlers/adminHandler.mjs
// Handles all admin dashboard socket events

import { supabaseAdmin } from '../../config/supabase.mjs';
import { logger } from '../../config/logger.mjs';
import { v4 as uuidv4 } from 'uuid';
import { getPendingRooms, getRoom, deleteRoom, addRoom, updateRoom } from '../runtime/sessionRuntime.mjs';
import { releaseReservation, reserveFunds, getAvailableBalance } from '../../db/walletRepo.mjs';
import { createSession, updateSessionStatus } from '../../db/sessionRepo.mjs';
import { getInterpreterByUserId } from '../../db/interpreterRepo.mjs';
import { generateAgoraToken } from '../../services/agoraService.mjs';
import { CLIENT_RATES } from '../../utils/constants.mjs';
import { emitToUser } from '../../utils/socketUtils.mjs';
import { eventBus, EVENTS } from '../../utils/eventBus.mjs';

// Same window used for a client's own preferred-interpreter selection in
// requestHandler.mjs — kept identical so this reuses that file's existing
// accept/expire/fallback-to-broadcast logic untouched, rather than
// inventing a second, parallel version of it here.
const PREFERRED_INTERPRETER_WINDOW_MS = 20_000;

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
    // FIX: was missing to_language entirely — this function only ever
    // selected `language` (the "from" side), so the admin Live Sessions
    // widget's session.toLang was always undefined regardless of what the
    // client actually booked. Session type also wasn't being consumed by
    // the widget's language-pair display, but is needed elsewhere in this
    // same response (type: s.session_type below), so left as-is.
    .select('id, agora_channel, language, to_language, session_type, started_at, client_id, interpreter_id, users!sessions_client_id_fkey(full_name)')
    .eq('status', 'active')
    .order('started_at', { ascending: false })
    .limit(20);

  if (error) { logger.error({ error }, 'getLiveSessions failed'); return []; }
  return (data || []).map(s => ({
    id:            s.id,
    channel:       s.agora_channel,
    // FIX: LiveSessions.jsx (admin dashboard widget) reads session.fromLang
    // and session.toLang as two separate fields — this used to only send a
    // single `language` field (and never to_language at all), so toLang was
    // always undefined for every session. Kept `language` too since it's
    // possible something else still reads that single-field shape; adding
    // fromLang/toLang alongside it rather than replacing it outright.
    language:      s.language,
    fromLang:      s.language,
    toLang:        s.to_language,
    type:          s.session_type,
    startedAt:     s.started_at,
    clientName:    s.users?.full_name ?? 'Unknown',
    clientId:      s.client_id,
    interpreterId: s.interpreter_id,
  }));
}

async function getRequestQueue() {
  const pending = getPendingRooms();
  // FIX: getPendingRooms() already flattens room.requestData onto each
  // object (see sessionRuntime.mjs — { roomId, ...room.requestData }), so
  // r.fromLang/r.toLang are genuinely present here. This mapping just never
  // copied them into its returned shape — RequestQueue.jsx (admin dashboard
  // widget) reads req.fromLang/req.toLang as two separate fields, so toLang
  // was always undefined for every pending request. Same bug shape as
  // getLiveSessions() above, different source (in-memory rooms vs DB).
  return pending.map(r => ({
    id:        r.requestId ?? r.id,
    language:  r.language,
    fromLang:  r.fromLang ?? r.language,
    toLang:    r.toLang,
    // FIX: was `purpose: r.purpose` — r.purpose doesn't exist on this
    // object (the real field from requestData is `category`, per
    // requestHandler.mjs), and RequestQueue.jsx reads req.category, not
    // req.purpose — wrong on both ends, so this badge has always been
    // blank regardless of what category the client actually picked.
    category:  r.category,
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
    // FIX: this never sent a `status` field at all, but the dashboard's
    // InterpreterPresence.jsx widget does statusConfig[i.status].dot with
    // no guard — i.status was always undefined, statusConfig[undefined]
    // was always undefined, and .dot on that crashed the whole Overview
    // page on the very first render once real data started flowing (this
    // was masked until now by the separate ext-prop bug that kept this
    // widget's data empty). Same fix already applied to the admin
    // Interpreters list route in admin.mjs — can't distinguish "online but
    // not in a call" from "busy in an active session" here either (would
    // need a join against active sessions), so this only derives the two
    // states available: is_available -> online, anything else -> offline.
    status:      i.is_available ? 'online' : 'offline',
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
    id:              p.id,
    interpreterId:   p.interpreter_id,
    interpreterName: p.users?.full_name ?? 'Unknown',
    amount:          p.amount,
    currency:        p.currency,
    requestedAt:     p.requested_at,
  }));
}

async function getAlerts() {
  const { data: disputes } = await supabaseAdmin
    .from('disputes')
    .select('id, reason, created_at')
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(5);

  return (disputes || []).map(d => ({
    id:       d.id,
    severity: 'warn',
    title:    'Open dispute',
    detail:   d.reason ?? 'No reason given',
    time:     d.created_at,
  }));
}

async function getSystemHealth() {
  const { data: sessions } = await supabaseAdmin
    .from('sessions')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'active');

  return [
    { label: 'Database',     status: 'ok' },
    { label: 'Socket',       status: 'ok' },
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

  socket.on('get-platform-stats',       async () => { try { socket.emit('platform-stats',       await getPlatformStats());       } catch (e) { logger.error(e, 'platform-stats error'); } });
  socket.on('get-live-sessions',        async () => { try { socket.emit('live-sessions',        await getLiveSessions());        } catch (e) { logger.error(e, 'live-sessions error'); } });
  socket.on('get-request-queue',        async () => { try { socket.emit('request-queue',        await getRequestQueue());        } catch (e) { logger.error(e, 'request-queue error'); } });
  socket.on('get-interpreter-presence', async () => { try { socket.emit('interpreter-presence', await getInterpreterPresence()); } catch (e) { logger.error(e, 'interpreter-presence error'); } });
  socket.on('get-active-disputes',      async () => { try { socket.emit('active-disputes',      await getActiveDisputes());      } catch (e) { logger.error(e, 'active-disputes error'); } });
  socket.on('get-payout-queue',         async () => { try { socket.emit('payout-queue',         await getPayoutQueue());         } catch (e) { logger.error(e, 'payout-queue error'); } });
  socket.on('get-alerts',               async () => { try { socket.emit('operational-alerts',   await getAlerts());              } catch (e) { logger.error(e, 'alerts error'); } });
  socket.on('get-system-health',        async () => { try { socket.emit('system-health',        await getSystemHealth());        } catch (e) { logger.error(e, 'system-health error'); } });
  socket.on('get-snapshot',             async () => { try { socket.emit('snapshot',             await getSnapshot());            } catch (e) { logger.error(e, 'snapshot error'); } });

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

  // ── ADMIN MANUALLY RE-BROADCASTS A STUCK PENDING REQUEST ──────────────────
  // Requests already auto-broadcast to all online interpreters on creation
  // (see requestHandler.mjs). This re-nudges a request that's been pending
  // too long — useful when interpreters missed the original broadcast
  // (e.g. they connected after it fired).
  socket.on('admin-assign-interpreter', async ({ requestId }) => {
    try {
      const room = getRoom(requestId);
      if (!room) {
        socket.emit('error', { code: 'ROOM_NOT_FOUND', message: 'Request no longer pending' });
        return;
      }

      io.to('interpreters').emit('new-request', { roomId: requestId, ...room.requestData });
      io.to('admins').emit('request-reassigned', { requestId });

      logger.info({ requestId, adminId: socket.userId }, 'Admin re-broadcast pending request');
    } catch (e) {
      logger.error(e, 'admin-assign-interpreter error');
    }
  });

  // ── ADMIN SKIPS/CANCELS A PENDING REQUEST ──────────────────────────────────
  // Releases the client's reserved funds, marks the session cancelled, and
  // removes the room — same cleanup as a client-initiated cancel, just
  // triggered by an admin instead.
  socket.on('admin-skip-request', async ({ requestId }) => {
    try {
      const room = getRoom(requestId);
      if (!room) {
        socket.emit('error', { code: 'ROOM_NOT_FOUND', message: 'Request no longer pending' });
        return;
      }

      await releaseReservation(room.clientUserId, room.reservedAmount, 'client');
      eventBus.emit(EVENTS.WALLET_CREDITED, { userId: room.clientUserId });
      await updateSessionStatus(room.sessionId, 'cancelled', { ended_at: new Date().toISOString() });

      deleteRoom(requestId);

      io.to('interpreters').emit('request-cancelled', { roomId: requestId });
      io.to('admins').emit('request-cancelled', { roomId: requestId });

      logger.info({ requestId, adminId: socket.userId }, 'Admin skipped/cancelled request');
    } catch (e) {
      logger.error(e, 'admin-skip-request error');
    }
  });

  // ── ADMIN MANUALLY CREATES + ASSIGNS A SESSION ─────────────────────────────
  // FIX: the "+ Assign session" button on the admin dashboard had no
  // onClick handler at all. This is a genuinely different action from
  // admin-assign-interpreter above (which just re-broadcasts an EXISTING
  // pending request) — this creates a brand new session from scratch for a
  // client + interpreter the admin picks directly (e.g. a VIP client, or an
  // edge case outside the normal booking flow).
  //
  // Deliberately reuses the exact same primitives requestHandler.mjs's
  // request-call uses (createSession, reserveFunds, generateAgoraToken,
  // addRoom with a preferredInterpreterId window) rather than inventing a
  // parallel "instant assign" path — that means this goes through the same
  // already-tested accept/expire/fallback-to-broadcast logic in
  // acceptHandler.mjs and jobs/requestTimeouts.mjs for free, instead of a
  // second, divergent implementation of the same thing.
  socket.on('admin-create-assignment', async ({ clientId, interpreterId, language, toLang, sessionType, purpose, duration } = {}) => {
    try {
      if (!clientId || !interpreterId || !language || !sessionType) {
        socket.emit('admin-assignment-result', { ok: false, reason: 'Client, interpreter, language, and session type are required' });
        return;
      }

      const interpreter = await getInterpreterByUserId(interpreterId).catch(() => null);
      if (!interpreter) {
        socket.emit('admin-assignment-result', { ok: false, reason: 'Selected interpreter not found' });
        return;
      }

      const wallet = await getAvailableBalance(clientId, 'client');
      const ratePerMin = CLIENT_RATES.USD[sessionType] ?? 1.49;
      if (wallet.availableBalance < ratePerMin) {
        socket.emit('admin-assignment-result', {
          ok: false,
          reason: `Client's wallet balance ($${wallet.availableBalance.toFixed(2)}) is below the $${ratePerMin.toFixed(2)} minimum for a ${sessionType} session.`,
        });
        return;
      }

      const roomId = uuidv4();
      const bookedDuration = parseInt(duration) * 60 || 1800;

      await reserveFunds(clientId, ratePerMin, 'client');
      eventBus.emit(EVENTS.WALLET_CREDITED, { userId: clientId, ...await getAvailableBalance(clientId, 'client') });

      const session = await createSession({
        clientId,
        language,
        toLang,
        purpose:      purpose ?? 'general',
        sessionType,
        currency:     wallet.currency ?? 'USD',
        agoraChannel: roomId,
        bookedDuration,
        duration,
      });

      let agoraToken = null;
      try {
        agoraToken = generateAgoraToken(roomId).token;
      } catch (e) {
        logger.warn({ e }, 'Agora token generation failed for admin-created assignment — client will retry');
      }

      addRoom(roomId, {
        clientSocketId: null, // admin created this, not the client's own socket
        clientUserId:   clientId,
        sessionId:      session.id,
        reservedAmount: ratePerMin,
        channelName:    roomId,
        createdAt:      Date.now(),
        preferredInterpreterId: interpreterId,
        preferredUntil:         Date.now() + PREFERRED_INTERPRETER_WINDOW_MS,
        requestData: {
          language, fromLang: language, toLang, sessionType, duration,
          category: purpose, interpreterId, roomId, channelName: roomId,
          adminAssigned: true,
        },
      });

      const requestPayload = {
        roomId, channelName: roomId, language, fromLang: language, toLang,
        sessionType, duration, category: purpose, clientName: 'Client', adminAssigned: true,
      };

      // Client wasn't the one connected/emitting here, unlike the normal
      // flow, so this needs a targeted emit rather than socket.emit().
      emitToUser(io, clientId, 'call-requested', { roomId, sessionId: session.id, channelName: roomId, agoraToken, sessionType });
      emitToUser(io, interpreterId, 'new-request', requestPayload);
      io.to('admins').emit('new-request', requestPayload);

      setTimeout(() => {
        const room = getRoom(roomId);
        if (!room || room.interpreterSocketId) return;
        updateRoom(roomId, { preferredInterpreterId: null, preferredUntil: null });
        io.to('interpreters').emit('new-request', requestPayload);
        logger.info({ roomId, interpreterId }, 'Admin-assigned interpreter window expired — broadcasting to all');
      }, PREFERRED_INTERPRETER_WINDOW_MS);

      socket.emit('admin-assignment-result', { ok: true, sessionId: session.id, roomId });
      logger.info({ adminId: socket.userId, clientId, interpreterId, sessionId: session.id }, 'Admin created manual session assignment');
    } catch (e) {
      logger.error(e, 'admin-create-assignment error');
      socket.emit('admin-assignment-result', { ok: false, reason: 'Failed to create the session — please try again' });
    }
  });

  // ── Real-time top-up push ─────────────────────────────────────
  const onTopUp = (data) => {
    io.to('admins').emit('wallet-topped-up', {
      userId:   data.userId,
      userName: data.userName,
      amount:   data.amount,
      currency: data.currency,
      time:     new Date().toISOString(),
    });
  };
  eventBus.on(EVENTS.WALLET_TOPPED_UP, onTopUp);

  // Clean up when this admin socket disconnects — prevents listener
  // accumulation and duplicate pushes on reconnect
  socket.on('disconnect', () => {
    eventBus.off(EVENTS.WALLET_TOPPED_UP, onTopUp);
  });

  logger.info({ userId: socket.userId }, 'Admin handlers registered');
}