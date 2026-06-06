import { logger } from '../config/logger.mjs';
import {
  createSession as createSessionRepo,
  getSessionById,
  activateSession,
  updateSessionStatus,
  getStaleSessions,
} from '../db/sessionRepo.mjs';
import { releaseReservation } from '../db/walletRepo.mjs';
import { RESERVATION_AMOUNT } from '../utils/constants.mjs';

/**
 * Create session in DB
 */
export async function createSession(data) {
  const session = await createSessionRepo(data);
  logger.info({ sessionId: session.id, clientId: data.clientId }, 'Session created');
  return session;
}

/**
 * Start session — mark active, record started_at
 */
export async function startSession(sessionId, interpreterId) {
  const session = await activateSession(sessionId, interpreterId);
  logger.info({ sessionId, interpreterId }, 'Session activated');
  return session;
}

/**
 * End session — closes record only.
 * WARNING: Vault-model per-minute billing is handled by billingService.mjs.
 * This function must NEVER deduct wallets — it only updates status + timestamps.
 */
export async function endSession(sessionId, reason = 'completed') {
  const session = await getSessionById(sessionId).catch(() => null);

  if (!session) {
    logger.warn({ sessionId }, 'endSession: session not found');
    return null;
  }

  if (['completed', 'cancelled', 'failed'].includes(session.status)) {
    logger.warn({ sessionId, status: session.status }, 'Session already ended');
    return session;
  }

  // Session never started — release reservation and mark cancelled
  if (!session.started_at || session.status === 'pending') {
    const reservedAmount = RESERVATION_AMOUNT.USD?.[session.session_type] ?? 0;
    if (reservedAmount > 0) {
      await releaseReservation(session.client_id, reservedAmount, 'client').catch(() => {});
    }
    await updateSessionStatus(sessionId, 'cancelled', {
      ended_at: new Date().toISOString(),
      ...(reason === 'force' ? { force_ended_at: new Date().toISOString() } : {}),
    });
    logger.info({ sessionId }, 'Session cancelled (never started)');
    return null;
  }

  // Compute final duration for the record
  const rawSeconds = Math.floor(
    (new Date() - new Date(session.started_at)) / 1000
  );
  const durationMinutes = Math.ceil(rawSeconds / 60);

  // Close record — NO wallet deduction here (billingService handled per-minute)
  await updateSessionStatus(sessionId, 'completed', {
    raw_duration_sec: rawSeconds,
    duration_minutes: durationMinutes,
    ended_at:         new Date().toISOString(),
    end_reason:       reason,
    ...(reason === 'force' ? { force_ended_at: new Date().toISOString() } : {}),
  });

  logger.info({ sessionId, rawSeconds, durationMinutes, reason }, 'Session record closed');
  return { sessionId, rawSeconds, durationMinutes };
}

/**
 * Force-end all stale sessions (called by cron)
 */
export async function forceEndStaleSessions(thresholdHours = 3) {
  const sessions = await getStaleSessions(thresholdHours);
  logger.info({ count: sessions.length }, 'Force-ending stale sessions');

  for (const s of sessions) {
    try {
        await endSession(s.id, 'force');
      // stopBilling removed — billing refactor uses global ticks, no per-session tracker
    } catch (err) {
      logger.error({ err, sessionId: s.id }, 'Force-end failed');
    }
  }
}