import { logger } from '../config/logger.mjs';
import { startStaleSessionsJob, stopStaleSessionsJob } from './staleSessions.mjs';
import { startReleaseReservationsJob, stopReleaseReservationsJob } from './releaseReservations.mjs';

export function startAllJobs() {
  logger.info('Starting background jobs');
  startStaleSessionsJob();
  startReleaseReservationsJob();
}

export function stopAllJobs() {
  logger.info('Stopping background jobs');
  stopStaleSessionsJob();
  stopReleaseReservationsJob();
}
