import { logger } from '../config/logger.mjs';
import { getStaleReservations, releaseReservation } from '../db/walletRepo.mjs';
import { updateSessionStatus } from '../db/sessionRepo.mjs';
import { CLIENT_RATES } from '../utils/constants.mjs'; // FIX: vault-model rates

// Run every 2 minutes
const INTERVAL_MS = 2 * 60 * 1000;
let interval = null;

export function startReleaseReservationsJob() {
  logger.info('Release reservations job started (2min interval)');
  runJob();
  interval = setInterval(runJob, INTERVAL_MS);
}

export function stopReleaseReservationsJob() {
  if (interval) {
    clearInterval(interval);
    interval = null;
    logger.info('Release reservations job stopped');
  }
}

async function runJob() {
  try {
    const stale = await getStaleReservations(2);
    if (!stale.length) return;

    logger.info({ count: stale.length }, 'Releasing stale reservations');

    for (const session of stale) {
      try {
        // FIX: vault-model — reserve one active minute as buffer, or $0 if no reservation
        const ratePerMin = CLIENT_RATES.USD[session.session_type] ?? 1.49;
        const reservedAmount = ratePerMin; // one minute buffer

        if (reservedAmount > 0) {
          await releaseReservation(session.client_id, reservedAmount, 'client'); // FIX: vault-aware
        }

        await updateSessionStatus(session.id, 'cancelled', {
          ended_at: new Date().toISOString(),
        });

        logger.info({ sessionId: session.id, released: reservedAmount }, 'Stale reservation released');
      } catch (err) {
        logger.error({ err, sessionId: session.id }, 'Release failed');
      }
    }
  } catch (err) {
    logger.error({ err }, 'Release reservations job failed');
  }
}