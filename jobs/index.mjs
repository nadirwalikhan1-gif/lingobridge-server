import { logger } from '../config/logger.mjs';
import { startStaleSessionsJob, stopStaleSessionsJob } from './staleSessions.mjs';
import { startReleaseReservationsJob, stopReleaseReservationsJob } from './releaseReservations.mjs';
import { startRequestTimeoutsJob, stopRequestTimeoutsJob } from './requestTimeouts.mjs'; // NEW

export function startAllJobs(io) {
  logger.info('Starting background jobs');
  startStaleSessionsJob();
  startReleaseReservationsJob();
  startRequestTimeoutsJob(io); // NEW — needs io to notify clients on timeout
}

export function stopAllJobs() {
  logger.info('Stopping background jobs');
  stopStaleSessionsJob();
  stopReleaseReservationsJob();
  stopRequestTimeoutsJob(); // NEW
}
