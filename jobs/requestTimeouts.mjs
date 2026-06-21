// jobs/requestTimeouts.mjs
//
// Enforces platform_settings.request_timeout_seconds, which was configurable
// in the admin UI but enforced nowhere — pending call requests with no
// interpreter response sat forever, and the client was never notified
// (request-cancelled only ever broadcast to 'interpreters'/'admins').
//
// Runs every 30s: checks in-memory pending rooms against the configured
// timeout, releases the client's wallet reservation, marks the session
// cancelled, and notifies the client directly (via emitToUser — same
// pattern already used for wallet balance pushes), plus interpreters/admins
// so their queues update too.

import { supabaseAdmin } from '../config/supabase.mjs';
import { getPendingRoomsFull, deleteRoom } from '../socket/runtime/sessionRuntime.mjs';
import { updateSessionStatus } from '../db/sessionRepo.mjs';
import { releaseReservation } from '../db/walletRepo.mjs';
import { emitToUser } from '../utils/socketUtils.mjs';
import { logger } from '../config/logger.mjs';

const CHECK_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_SECONDS = 180; // matches platform_settings default

let intervalId = null;
let ioRef = null;

async function getRequestTimeoutSeconds() {
  try {
    const { data, error } = await supabaseAdmin
      .from('platform_settings')
      .select('request_timeout_seconds')
      .eq('id', 1)
      .single();

    if (error || !data) return DEFAULT_TIMEOUT_SECONDS;
    return data.request_timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
  } catch (err) {
    logger.warn({ err }, 'Could not read request_timeout_seconds, using default');
    return DEFAULT_TIMEOUT_SECONDS;
  }
}

async function checkRequestTimeouts() {
  if (!ioRef) return;

  try {
    const timeoutSeconds = await getRequestTimeoutSeconds();
    const timeoutMs = timeoutSeconds * 1000;
    const now = Date.now();

    const pending = getPendingRoomsFull();
    let expired = 0;

    for (const room of pending) {
      if (!room.createdAt || now - room.createdAt < timeoutMs) continue;

      expired += 1;
      const { roomId, sessionId, clientUserId, reservedAmount } = room;

      try {
        if (reservedAmount > 0) {
          await releaseReservation(clientUserId, reservedAmount, 'client');
        }
        await updateSessionStatus(sessionId, 'cancelled', {
          ended_at: new Date().toISOString(),
        });

        const pushed = emitToUser(ioRef, clientUserId, 'request-cancelled', {
          roomId,
          reason: 'timeout',
          message: 'No interpreter was available in time. Your request has been cancelled and any reserved funds released.',
        });

        ioRef.to('interpreters').emit('request-cancelled', { roomId });
        ioRef.to('admins').emit('request-cancelled', { roomId });

        deleteRoom(roomId);

        logger.info({ roomId, sessionId, clientUserId, timeoutSeconds, notifiedClient: pushed > 0 }, 'Request timed out — cancelled');
      } catch (err) {
        logger.error({ err, roomId, sessionId }, 'Failed to process request timeout');
      }
    }

    if (expired > 0) {
      logger.info({ expired, timeoutSeconds }, 'Request timeout sweep complete');
    }
  } catch (err) {
    logger.error({ err }, 'Request timeout job failed');
  }
}

export function startRequestTimeoutsJob(io) {
  ioRef = io;
  intervalId = setInterval(checkRequestTimeouts, CHECK_INTERVAL_MS);
  logger.info(`Request timeout job started (${CHECK_INTERVAL_MS / 1000}s interval)`);
}

export function stopRequestTimeoutsJob() {
  if (intervalId) clearInterval(intervalId);
  intervalId = null;
  ioRef = null;
}
