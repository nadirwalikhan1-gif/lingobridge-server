import { logger } from '../config/logger.mjs';
import { getStaleReservations, releaseReservation } from '../db/walletRepo.mjs';
import { updateSessionStatus } from '../db/sessionRepo.mjs';
import { RESERVATION_AMOUNT } from '../utils/constants.mjs';

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
    // Find pending sessions older than 2 minutes (no interpreter accepted)
    const stale = await getStaleReservations(2);

    if (!stale.length) return;

    logger.info({ count: stale.length }, 'Releasing stale reservations');

    for (const session of stale) {
      try {
        // Release reservation
        const reservedAmount =
          RESERVATION_AMOUNT['USD']?.['video'] ?? 18.00; // fallback

        await releaseReservation(session.client_id, reservedAmount);
        await updateSessionStatus(session.id, 'cancelled', {
          ended_at: new Date().toISOString(),
        });

        logger.info({ sessionId: session.id }, 'Stale reservation released');
      } catch (err) {
        logger.error({ err, sessionId: session.id }, 'Release failed');
      }
    }
  } catch (err) {
    logger.error({ err }, 'Release reservations job failed');
  }
}
