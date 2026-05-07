import { logger } from '../config/logger.mjs';
import {
  createSession as createSessionRepo,
  getSessionById,
  activateSession,
  updateSessionStatus,
  getStaleSessions,
} from '../db/sessionRepo.mjs';
import { deductWallet, releaseReservation } from '../db/walletRepo.mjs';
import { calculateCost } from './billingService.mjs';
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
 * End session — atomic wallet deduction + status update
 */
export async function endSession(sessionId, reason = 'completed') {
  const session = await getSessionById(sessionId).catch(() => null);

  if (!session) {
    logger.warn({ sessionId }, 'endSession: session not found');
    return null;
  }

  // Prevent double-processing
  if (['completed', 'cancelled', 'failed'].includes(session.status)) {
    logger.warn({ sessionId, status: session.status }, 'Session already ended');
    return session;
  }

  // Never started — cancel and release reservation
  if (!session.started_at || session.status === 'pending') {
    const reservedAmount = RESERVATION_AMOUNT[session.currency || 'USD']?.[session.session_type] ?? 18.00;
    await releaseReservation(session.client_id, reservedAmount).catch(() => {});
    await updateSessionStatus(sessionId, 'cancelled', {
      ended_at: new Date().toISOString(),
      ...(reason === 'force' ? { force_ended_at: new Date().toISOString() } : {}),
    });
    logger.info({ sessionId }, 'Session cancelled (never started)');
    return null;
  }

  // Calculate final cost
  const { rawSeconds, cost } = calculateCost(
    session.started_at,
    session.currency || 'USD',
    session.session_type
  );

  const durationMinutes = Math.ceil(rawSeconds / 60);

  // Update duration fields immediately
  await updateSessionStatus(sessionId, session.status, {
    raw_duration_sec: rawSeconds,
    duration_minutes: durationMinutes,
    ended_at:         new Date().toISOString(),
    ...(reason === 'force' ? { force_ended_at: new Date().toISOString() } : {}),
  });

  // Atomic wallet deduction via DB function
  try {
    const result = await deductWallet(
      session.client_id,
      sessionId,
      cost,
      `${session.session_type} session — ${session.language} (${durationMinutes} min)`
    );

    if (!result?.success) {
      throw new Error(result?.error || 'Deduction failed');
    }

    logger.info({ sessionId, cost, rawSeconds, reason }, 'Session ended + wallet deducted');
    return { sessionId, cost, rawSeconds, durationMinutes };

  } catch (err) {
    logger.error({ err, sessionId }, 'Wallet deduction failed — marking session failed');
    await updateSessionStatus(sessionId, 'failed');
    throw err;
  }
}

/**
 * Force-end all stale sessions (called by cron)
 */
export async function forceEndStaleSessions(thresholdHours = 3) {
  const sessions = await getStaleSessions(thresholdHours);
  logger.info({ count: sessions.length }, 'Force-ending stale sessions');

  for (const s of sessions) {
    await endSession(s.id, 'force').catch((err) =>
      logger.error({ err, sessionId: s.id }, 'Force-end failed')
    );
  }
}
