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
      // FIX: was socket.emit (only reached the tab that clicked it) — now
      // broadcasts to every open tab/device for this user via the
      // per-user room joined in socket/index.mjs on connect.
      io.to(`user:${socket.userId}`).emit('status-update', { status: 'offline' });
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
      // FIX: was socket.emit (only reached the tab that clicked it) — now
      // broadcasts to every open tab/device for this user via the
      // per-user room joined in socket/index.mjs on connect.
      io.to(`user:${socket.userId}`).emit('status-update', { status: 'online' });

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
  // Added to back the dashboard's three-state availability toggle
  // (Online / Break / Offline). Leaves the 'interpreters' room same as
  // offline (so no new requests are routed here), but persists a distinct
  // 'break' status so the UI can show it differently from fully offline.
  socket.on('go-on-break', async () => {
    if (!socket.interpreterRole) return;

    socket.leave('interpreters');

    if (socket.userId) {
      await setInterpreterStatus(socket.userId, 'break').catch((err) =>
        logger.warn({ err, userId: socket.userId }, 'setInterpreterStatus(break) failed')
      );
    }

    socket.emit('status-update', { status: 'break' });
    logger.info({ socketId: socket.id, userId: socket.userId }, 'Interpreter went on break');
  });
}