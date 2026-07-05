import { logger } from '../../config/logger.mjs';
import { setInterpreterAvailability, setInterpreterStatus } from '../../db/interpreterRepo.mjs';
import { getWalletByUserId } from '../../db/walletRepo.mjs';           // FIX: vault-model
import { supabaseAdmin } from '../../config/supabase.mjs';             // FIX: vault-model
import { getPendingRooms } from '../runtime/sessionRuntime.mjs';

/**
 * registerHandler.mjs
 *
 * Handles interpreter online/offline registration via explicit 'register' event.
 * NOTE: Role-based room joining also happens automatically in index.mjs on connect,
 * so interpreters receive broadcasts even without emitting 'register'.
 */
export function requestHandler(io, socket) {
  // ── REGISTER (interpreter / client comes online) ──────────────
  socket.on('register', async (data) => {
    const role = data?.role;

    if (role === 'interpreter') {
      socket.join('interpreters');
      socket.interpreterRole = true;

      if (socket.userId) {
        // FIX: 'register' is ALSO auto-emitted by lib/socket.js on every
        // single connect/reconnect (page nav, tab refocus, network blip) —
        // completely separate from a deliberate "go online" click. It must
        // NOT force status to 'online' here, or any reconnect silently
        // overwrites an interpreter's explicit Break/Offline choice. Socket
        // housekeeping (room join, vault check) still happens; the actual
        // "online" status write now only happens via the dedicated
        // 'go-online' event, fired only when the user explicitly picks it.
        await setInterpreterAvailability(socket.userId, true).catch((err) =>
          logger.warn({ err, userId: socket.userId }, 'setInterpreterAvailability failed')
        );

        // FIX: vault-model — ensure interpreter has an earnings vault
        try {
          await getWalletByUserId(socket.userId, 'interpreter');
        } catch (e) {
          await supabaseAdmin
            .from('wallets')
            .insert({
              user_id: socket.userId,
              vault_type: 'interpreter',
              balance: 0,
              currency: 'USD',
              reserved_balance: 0,
            });
          logger.info({ userId: socket.userId }, 'Created interpreter vault wallet');
        }
      }

      const pending = getPendingRooms();
      if (pending.length > 0) {
        socket.emit('pending-requests', pending);
      }

      logger.info(
        { socketId: socket.id, userId: socket.userId, pendingSent: pending.length },
        'Interpreter registered via event'
      );
    }

    if (role === 'client') {
      socket.clientRole = true;
      logger.info({ socketId: socket.id, userId: socket.userId }, 'Client registered');
    }
  });

  // ── GO OFFLINE ────────────────────────────────────────────────
  socket.on('go-offline', async () => {
    if (!socket.interpreterRole) return;

    socket.leave('interpreters');
    socket.interpreterRole = false;

    if (socket.userId) {
      // FIX: same is_available-only gap as 'register' above.
      await setInterpreterStatus(socket.userId, 'offline').catch((err) =>
        logger.warn({ err, userId: socket.userId }, 'setInterpreterStatus(offline) failed')
      );
      socket.emit('status-update', { status: 'offline' });
    }

    logger.info({ socketId: socket.id, userId: socket.userId }, 'Interpreter went offline');
  });

  // ── GO ONLINE ─────────────────────────────────────────────────
  socket.on('go-online', async () => {
    socket.join('interpreters');
    socket.interpreterRole = true;

    if (socket.userId) {
      // FIX: same is_available-only gap as 'register' above.
      await setInterpreterStatus(socket.userId, 'online').catch((err) =>
        logger.warn({ err, userId: socket.userId }, 'setInterpreterStatus(online) failed')
      );
      socket.emit('status-update', { status: 'online' });

      // FIX: vault-model — ensure interpreter vault exists on reconnect too
      try {
        await getWalletByUserId(socket.userId, 'interpreter');
      } catch (e) {
        await supabaseAdmin
          .from('wallets')
          .insert({
            user_id: socket.userId,
            vault_type: 'interpreter',
            balance: 0,
            currency: 'USD',
            reserved_balance: 0,
          });
        logger.info({ userId: socket.userId }, 'Created interpreter vault wallet');
      }
    }

    const pending = getPendingRooms();
    if (pending.length > 0) {
      socket.emit('pending-requests', pending);
    }

    logger.info({ socketId: socket.id, userId: socket.userId }, 'Interpreter came back online');
  });

  // ── GO ON BREAK ───────────────────────────────────────────────
  // REMOVED: platform decision — interpreter availability is now binary
  // (Online/Offline) only. Neither Dashboard.jsx nor Availability.jsx emits
  // 'go-on-break' anymore (both moved to a shared statusConfig.js with just
  // STATUS.ONLINE/STATUS.OFFLINE). This handler is intentionally deleted
  // rather than left in place unreachable — see the project's established
  // practice of not leaving dead code as a trap for the next person who
  // finds it. Accompanying DB migration backfills any existing 'break' rows
  // to 'offline' and tightens the status CHECK constraint to match.
}
