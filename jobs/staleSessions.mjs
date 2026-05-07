import { forceEndStaleSessions }         from '../services/sessionService.mjs';
import { logger }                         from '../config/logger.mjs';
// FIX: was importing STALE_SESSION_THRESHOLD_HOURS which wasn't exported from constants.
import { STALE_SESSION_THRESHOLD_HOURS }  from '../utils/constants.mjs';

const INTERVAL_MS = 60 * 1000; // every 60 seconds
let interval = null;

export function startStaleSessionsJob() {
  logger.info('Stale sessions job started (60s interval)');
  runJob(); // run immediately on start
  interval = setInterval(runJob, INTERVAL_MS);
}

export function stopStaleSessionsJob() {
  if (interval) {
    clearInterval(interval);
    interval = null;
    logger.info('Stale sessions job stopped');
  }
}

async function runJob() {
  try {
    await forceEndStaleSessions(STALE_SESSION_THRESHOLD_HOURS);
  } catch (err) {
    logger.error({ err }, 'Stale sessions job failed');
  }
}
