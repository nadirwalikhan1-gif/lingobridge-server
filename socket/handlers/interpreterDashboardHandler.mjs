// socket/handlers/interpreterDashboardHandler.mjs
//
// Handles: get-dashboard-stats, get-earnings-summary, get-earnings-breakdown,
//          get-earnings-chart, get-payout-history, get-performance-stats,
//          get-rating-summary, get-reviews, get-transactions, get-balance,
//          get-interpreter-profile, get-interpreter-rates,
//          get-interpreter-settings, update-interpreter-profile,
//          update-interpreter-settings, request-data-export,
//          submit-support-ticket
//
// These were previously emitted by the interpreter dashboard with zero
// server-side handlers — every page silently hit its REST-fallback-timeout
// and fell back to an empty state. This file closes that gap.
//
// NOTE on acceptance rate: requests are broadcast to all online interpreters
// rather than tracked per-interpreter, and there's no record of who declined
// vs never saw a request. Acceptance rate is NOT included in performance
// stats below — it cannot be computed from existing data. Would need a new
// request-offer log table to track per-interpreter exposure.

import { rateLimitSocket } from '../../middleware/rateLimiter.mjs';
import { logger } from '../../config/logger.mjs';

import {
  getInterpreterByUserId,
  getPayoutsByInterpreter,
  getInterpreterBalance,
  getInterpreterSettings,
  updateInterpreterSettings,
  updateInterpreterProfile,
  getInterpreterRatingSummary,
  getInterpreterReviews,
} from '../../db/interpreterRepo.mjs';

import {
  getSessionsByInterpreter,
  getInterpreterSessionStats,
} from '../../db/sessionRepo.mjs';

import { getTransactionsByUser } from '../../db/transactionRepo.mjs';
import { updateUser } from '../../db/userRepo.mjs';
import { createSupportTicket } from '../../db/supportTicketRepo.mjs';
import { INTERPRETER_RATES, INTERPRETER_HOLD_RATE, HOLD_TIERS, SOCKET_EVENTS } from '../../utils/constants.mjs';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function requireAuth(socket) {
  if (!socket.userId) {
    socket.emit('error', { code: 'AUTH_REQUIRED', message: 'Authentication required' });
    return null;
  }
  return socket.userId;
}

function startOfDayISO(daysAgo = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function toCSV(rows, columns) {
  const header = columns.join(',');
  const lines = rows.map((row) =>
    columns.map((col) => {
      const val = row[col] ?? '';
      const escaped = String(val).replace(/"/g, '""');
      return /[,"\n]/.test(escaped) ? `"${escaped}"` : escaped;
    }).join(',')
  );
  return [header, ...lines].join('\n');
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export function interpreterDashboardHandler(io, socket) {
  // ── Dashboard stats ─────────────────────────────────────────────────────────
  socket.on('get-dashboard-stats', async () => {
    const userId = requireAuth(socket);
    if (!userId) return;

    try {
      const interpreter = await getInterpreterByUserId(userId);
      const todaySessions = await getInterpreterSessionStats(interpreter.id, startOfDayISO(0));
      const weekSessions  = await getInterpreterSessionStats(interpreter.id, startOfDayISO(7));
      const { availableBalance, currency } = await getInterpreterBalance(userId);

      socket.emit('dashboard-stats', {
        todaySessions: todaySessions.length,
        todayMinutes: todaySessions.reduce((s, x) => s + (x.duration_minutes || 0), 0),
        weekSessions: weekSessions.length,
        weekMinutes: weekSessions.reduce((s, x) => s + (x.duration_minutes || 0), 0),
        rating: interpreter.rating,
        availableBalance,
        currency,
        isAvailable: interpreter.is_available,
        status: interpreter.status,
      });
    } catch (err) {
      logger.error({ err, userId }, 'get-dashboard-stats failed');
      socket.emit('error', { code: 'SERVER_ERROR', message: 'Could not load dashboard stats' });
    }
  });

  // ── Earnings summary ────────────────────────────────────────────────────────
  socket.on('get-earnings-summary', async () => {
    const userId = requireAuth(socket);
    if (!userId) return;

    try {
      const interpreter = await getInterpreterByUserId(userId);
      const { balance, reservedBalance, availableBalance, currency } = await getInterpreterBalance(userId);

      const monthSessions = await getInterpreterSessionStats(interpreter.id, startOfDayISO(30));
      const totalEarningsThisMonth = monthSessions.reduce((sum, s) => {
        const rate = s.session_type === 'video' ? INTERPRETER_RATES.USD.video : INTERPRETER_RATES.USD.audio;
        return sum + (s.duration_minutes || 0) * rate;
      }, 0);

      socket.emit('earnings-summary', {
        balance,
        reservedBalance,
        availableBalance,
        currency,
        earningsThisMonth: parseFloat(totalEarningsThisMonth.toFixed(2)),
        sessionsThisMonth: monthSessions.length,
      });
    } catch (err) {
      logger.error({ err, userId }, 'get-earnings-summary failed');
      socket.emit('error', { code: 'SERVER_ERROR', message: 'Could not load earnings summary' });
    }
  });

  // ── Earnings breakdown (by language) ────────────────────────────────────────
  socket.on('get-earnings-breakdown', async () => {
    const userId = requireAuth(socket);
    if (!userId) return;

    try {
      const interpreter = await getInterpreterByUserId(userId);
      const sessions = await getInterpreterSessionStats(interpreter.id, startOfDayISO(30));

      const byLanguage = {};
      for (const s of sessions) {
        const rate = s.session_type === 'video' ? INTERPRETER_RATES.USD.video : INTERPRETER_RATES.USD.audio;
        const earning = (s.duration_minutes || 0) * rate;
        const key = s.language || 'Unknown';
        if (!byLanguage[key]) byLanguage[key] = { language: key, sessions: 0, minutes: 0, earnings: 0 };
        byLanguage[key].sessions += 1;
        byLanguage[key].minutes += s.duration_minutes || 0;
        byLanguage[key].earnings += earning;
      }

      const breakdown = Object.values(byLanguage)
        .map((b) => ({ ...b, earnings: parseFloat(b.earnings.toFixed(2)) }))
        .sort((a, b) => b.earnings - a.earnings);

      socket.emit('earnings-breakdown', { breakdown });
    } catch (err) {
      logger.error({ err, userId }, 'get-earnings-breakdown failed');
      socket.emit('error', { code: 'SERVER_ERROR', message: 'Could not load earnings breakdown' });
    }
  });

  // ── Earnings chart (daily, last 30 days) ────────────────────────────────────
  socket.on('get-earnings-chart', async () => {
    const userId = requireAuth(socket);
    if (!userId) return;

    try {
      const interpreter = await getInterpreterByUserId(userId);
      const sessions = await getInterpreterSessionStats(interpreter.id, startOfDayISO(30));

      const byDay = {};
      for (const s of sessions) {
        const rate = s.session_type === 'video' ? INTERPRETER_RATES.USD.video : INTERPRETER_RATES.USD.audio;
        const earning = (s.duration_minutes || 0) * rate;
        const day = (s.ended_at || s.created_at).slice(0, 10); // YYYY-MM-DD
        byDay[day] = (byDay[day] || 0) + earning;
      }

      const chart = Object.entries(byDay)
        .map(([date, earnings]) => ({ date, earnings: parseFloat(earnings.toFixed(2)) }))
        .sort((a, b) => a.date.localeCompare(b.date));

      socket.emit('earnings-chart-data', { chart });
    } catch (err) {
      logger.error({ err, userId }, 'get-earnings-chart failed');
      socket.emit('error', { code: 'SERVER_ERROR', message: 'Could not load earnings chart' });
    }
  });

  // ── Payout history ──────────────────────────────────────────────────────────
  socket.on('get-payout-history', async () => {
    const userId = requireAuth(socket);
    if (!userId) return;

    try {
      const interpreter = await getInterpreterByUserId(userId);
      const payouts = await getPayoutsByInterpreter(interpreter.id);
      socket.emit('payout-history', { payouts });
    } catch (err) {
      logger.error({ err, userId }, 'get-payout-history failed');
      socket.emit('error', { code: 'SERVER_ERROR', message: 'Could not load payout history' });
    }
  });

  // ── Performance stats ────────────────────────────────────────────────────────
  // Deliberately omits acceptance rate — see file header note.
  socket.on('get-performance-stats', async () => {
    const userId = requireAuth(socket);
    if (!userId) return;

    try {
      const interpreter = await getInterpreterByUserId(userId);
      const monthSessions = await getInterpreterSessionStats(interpreter.id, startOfDayISO(30));
      const ratingSummary = await getInterpreterRatingSummary(userId);

      const avgDuration = monthSessions.length > 0
        ? monthSessions.reduce((s, x) => s + (x.duration_minutes || 0), 0) / monthSessions.length
        : 0;

      socket.emit('performance-stats', {
        sessionsThisMonth: monthSessions.length,
        avgSessionMinutes: parseFloat(avgDuration.toFixed(1)),
        currentRating: ratingSummary.currentRating,
        ratingTrend: ratingSummary.trend,
        totalReviews: ratingSummary.totalReviews,
      });
    } catch (err) {
      logger.error({ err, userId }, 'get-performance-stats failed');
      socket.emit('error', { code: 'SERVER_ERROR', message: 'Could not load performance stats' });
    }
  });

  // ── Rating summary ───────────────────────────────────────────────────────────
  socket.on('get-rating-summary', async () => {
    const userId = requireAuth(socket);
    if (!userId) return;

    try {
      const summary = await getInterpreterRatingSummary(userId);
      socket.emit('rating-update', summary);
    } catch (err) {
      logger.error({ err, userId }, 'get-rating-summary failed');
      socket.emit('error', { code: 'SERVER_ERROR', message: 'Could not load rating summary' });
    }
  });

  // ── Reviews list ──────────────────────────────────────────────────────────────
  socket.on('get-reviews', async ({ limit = 20, offset = 0 } = {}) => {
    const userId = requireAuth(socket);
    if (!userId) return;

    try {
      const reviews = await getInterpreterReviews(userId, limit, offset);
      socket.emit('reviews-data', { reviews });
    } catch (err) {
      logger.error({ err, userId }, 'get-reviews failed');
      socket.emit('error', { code: 'SERVER_ERROR', message: 'Could not load reviews' });
    }
  });

  // ── Transactions ──────────────────────────────────────────────────────────────
  socket.on('get-transactions', async ({ limit = 20, offset = 0 } = {}) => {
    const userId = requireAuth(socket);
    if (!userId) return;

    try {
      const transactions = await getTransactionsByUser(userId, limit, offset, 'interpreter');
      socket.emit('transactions', { transactions });
    } catch (err) {
      logger.error({ err, userId }, 'get-transactions failed');
      socket.emit('error', { code: 'SERVER_ERROR', message: 'Could not load transactions' });
    }
  });

  // ── Balance ───────────────────────────────────────────────────────────────────
  socket.on('get-balance', async () => {
    const userId = requireAuth(socket);
    if (!userId) return;

    try {
      const balance = await getInterpreterBalance(userId);
      socket.emit(SOCKET_EVENTS.BALANCE_UPDATE, balance);
    } catch (err) {
      logger.error({ err, userId }, 'get-balance failed');
      socket.emit('error', { code: 'SERVER_ERROR', message: 'Could not load balance' });
    }
  });

  // ── Profile ───────────────────────────────────────────────────────────────────
  socket.on('get-interpreter-profile', async () => {
    const userId = requireAuth(socket);
    if (!userId) return;

    try {
      const profile = await getInterpreterByUserId(userId);
      socket.emit('interpreter-profile', { profile });
    } catch (err) {
      logger.error({ err, userId }, 'get-interpreter-profile failed');
      socket.emit('error', { code: 'SERVER_ERROR', message: 'Could not load profile' });
    }
  });

  socket.on('update-interpreter-profile', async (updates = {}) => {
    if (!rateLimitSocket(socket, 'update-interpreter-profile', { max: 10, windowMs: 60_000 })) return;
    const userId = requireAuth(socket);
    if (!userId) return;

    try {
      // full_name/avatar_url live on users table; bio/languages on interpreters
      if (updates.full_name !== undefined || updates.avatar_url !== undefined) {
        await updateUser(userId, updates);
      }
      const profile = await updateInterpreterProfile(userId, updates);
      socket.emit('profile-saved', { ok: true, profile });
    } catch (err) {
      logger.error({ err, userId }, 'update-interpreter-profile failed');
      socket.emit('profile-saved', { ok: false, reason: 'server_error' });
    }
  });

  // ── Rates (read-only — flat platform constants, not per-interpreter) ────────
  socket.on('get-interpreter-rates', async () => {
    const userId = requireAuth(socket);
    if (!userId) return;

    socket.emit('interpreter-rates', {
      rates: INTERPRETER_RATES.USD,
      holdRate: INTERPRETER_HOLD_RATE,
      holdTiers: HOLD_TIERS,
    });
  });

  // ── Settings ──────────────────────────────────────────────────────────────────
  socket.on('get-interpreter-settings', async () => {
    const userId = requireAuth(socket);
    if (!userId) return;

    try {
      const settings = await getInterpreterSettings(userId);
      socket.emit('interpreter-settings', { settings });
    } catch (err) {
      logger.error({ err, userId }, 'get-interpreter-settings failed');
      socket.emit('error', { code: 'SERVER_ERROR', message: 'Could not load settings' });
    }
  });

  socket.on('update-interpreter-settings', async (updates = {}) => {
    if (!rateLimitSocket(socket, 'update-interpreter-settings', { max: 10, windowMs: 60_000 })) return;
    const userId = requireAuth(socket);
    if (!userId) return;

    try {
      const settings = await updateInterpreterSettings(userId, updates);
      socket.emit('settings-saved', { ok: true, settings });
    } catch (err) {
      logger.error({ err, userId }, 'update-interpreter-settings failed');
      socket.emit('settings-saved', { ok: false, reason: 'server_error' });
    }
  });

  // ── Data export ───────────────────────────────────────────────────────────────
  // Generates a CSV directly and sends it back over the socket — frontend
  // triggers a browser download from the payload. No email step needed.
  socket.on('request-data-export', async () => {
    if (!rateLimitSocket(socket, 'request-data-export', { max: 3, windowMs: 60_000 })) return;
    const userId = requireAuth(socket);
    if (!userId) return;

    try {
      const interpreter = await getInterpreterByUserId(userId);
      const sessions = await getSessionsByInterpreter(interpreter.id, 1000, 0);
      const transactions = await getTransactionsByUser(userId, 1000, 0, 'interpreter');
      const payouts = await getPayoutsByInterpreter(interpreter.id);

      const csv = [
        '=== SESSIONS ===',
        toCSV(sessions, ['id', 'language', 'session_type', 'status', 'duration_minutes', 'cost', 'started_at', 'ended_at']),
        '',
        '=== TRANSACTIONS ===',
        toCSV(transactions, ['id', 'type', 'amount', 'currency', 'description', 'created_at']),
        '',
        '=== PAYOUTS ===',
        toCSV(payouts, ['id', 'amount', 'status', 'requested_at', 'resolved_at']),
      ].join('\n');

      socket.emit('data-export-ready', {
        ok: true,
        filename: `lingobridge-export-${new Date().toISOString().slice(0, 10)}.csv`,
        csv,
      });
    } catch (err) {
      logger.error({ err, userId }, 'request-data-export failed');
      socket.emit('data-export-ready', { ok: false, reason: 'server_error' });
    }
  });

  // ── Support ticket ────────────────────────────────────────────────────────────
  socket.on('submit-support-ticket', async ({ subject, message } = {}) => {
    if (!rateLimitSocket(socket, 'submit-support-ticket', { max: 5, windowMs: 60_000 })) return;
    const userId = requireAuth(socket);
    if (!userId) return;

    if (!subject?.trim() || !message?.trim()) {
      socket.emit('support-ticket-ack', { ok: false, reason: 'Subject and message are required' });
      return;
    }

    try {
      const ticket = await createSupportTicket({
        userId,
        role: 'interpreter',
        subject: subject.trim(),
        message: message.trim(),
      });
      socket.emit('support-ticket-ack', { ok: true, ticketId: ticket.id });
    } catch (err) {
      logger.error({ err, userId }, 'submit-support-ticket failed');
      socket.emit('support-ticket-ack', { ok: false, reason: 'server_error' });
    }
  });
}
