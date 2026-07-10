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
        // FIX: no code path anywhere in this backend ever INSERTs a row into
        // interpreters — every existing function (setInterpreterAvailability,
        // setInterpreterStatus, etc.) only ever UPDATEs an existing row,
        // which silently affects zero rows if one doesn't exist yet. This is
        // exactly the "missing interpreters row" bug fixed manually via SQL
        // for one legacy test account earlier in this project — without this,
        // it would recur for every genuinely new interpreter signup. Defaults
        // to is_verified: false / is_available: false — a new interpreter
        // shouldn't be bookable until an admin actually verifies them (see
        // POST /v1/admin/users/:id/approve), matching the real vetting the
        // product's "Background checked" claim implies.
        const { error: profileErr } = await supabaseAdmin
          .from('interpreters')
          .upsert(
            { user_id: socket.userId, is_available: false, is_verified: false, status: 'offline' },
            { onConflict: 'user_id', ignoreDuplicates: true }
          );
        if (profileErr) {
          logger.error({ err: profileErr, userId: socket.userId }, 'Failed to create interpreter profile row');
        }

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

        // FIX: vault-model — ensure interpreter has an earnings vault.
        // Upsert (matching authSocket.mjs / acceptHandler.mjs) rather than a
        // plain insert, so concurrent connections can't collide on the
        // (user_id, vault_type) constraint.
        try {
          await getWalletByUserId(socket.userId, 'interpreter');
        } catch (e) {
          const { error: insertErr } = await supabaseAdmin
            .from('wallets')
            .upsert(
              { user_id: socket.userId, vault_type: 'interpreter', balance: 0, currency: 'USD', reserved_balance: 0 },
              { onConflict: 'user_id,vault_type', ignoreDuplicates: true }
            );
          if (insertErr) {
            logger.error({ err: insertErr, userId: socket.userId }, 'Failed to create interpreter vault wallet');
          } else {
            logger.info({ userId: socket.userId }, 'Created interpreter vault wallet');
          }
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
      // (upsert, matching authSocket.mjs / acceptHandler.mjs)
      try {
        await getWalletByUserId(socket.userId, 'interpreter');
      } catch (e) {
        const { error: insertErr } = await supabaseAdmin
          .from('wallets')
          .upsert(
            { user_id: socket.userId, vault_type: 'interpreter', balance: 0, currency: 'USD', reserved_balance: 0 },
            { onConflict: 'user_id,vault_type', ignoreDuplicates: true }
          );
        if (insertErr) {
          logger.error({ err: insertErr, userId: socket.userId }, 'Failed to create interpreter vault wallet');
        } else {
          logger.info({ userId: socket.userId }, 'Created interpreter vault wallet');
        }
      }
    }

    const pending = getPendingRooms();
    if (pending.length > 0) {
      socket.emit('pending-requests', pending);
    }

    logger.info({ socketId: socket.id, userId: socket.userId }, 'Interpreter came back online');
  });

  // GO ON BREAK: removed — platform decision is binary Online/Offline only
  // (see features/interpreter/statusConfig.js). This handler was still
  // fully live and reachable here despite neither Dashboard.jsx nor
  // Availability.jsx ever emitting it, and used the old direct socket.emit
  // rather than the per-user room broadcast (see 'go-online'/'go-offline'
  // below) — genuinely dead code, not a working alternate path. Deleted
  // rather than left as an unreachable trap for the next person who finds
  // it. See migrations/20260709_remove_break_status.sql for the matching
  // DB-level cleanup (backfills any legacy 'break' rows, tightens the
  // status CHECK constraint).
}