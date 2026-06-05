import { logger } from '../../config/logger.mjs';
import { setInterpreterAvailability } from '../../db/interpreterRepo.mjs';
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
      await setInterpreterAvailability(socket.userId, false).catch((err) =>
        logger.warn({ err, userId: socket.userId }, 'setInterpreterAvailability(offline) failed')
      );
    }

    logger.info({ socketId: socket.id, userId: socket.userId }, 'Interpreter went offline');
  });

  // ── GO ONLINE ─────────────────────────────────────────────────
  socket.on('go-online', async () => {
    socket.join('interpreters');
    socket.interpreterRole = true;

    if (socket.userId) {
      await setInterpreterAvailability(socket.userId, true).catch((err) =>
        logger.warn({ err, userId: socket.userId }, 'setInterpreterAvailability(online) failed')
      );

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
}