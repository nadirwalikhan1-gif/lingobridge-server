import { verifySupabaseToken } from '../config/supabase.mjs';
import { getWalletByUserId } from '../db/walletRepo.mjs';
import { supabaseAdmin } from '../config/supabase.mjs';
import { logger } from '../config/logger.mjs';

/**
 * Socket.IO middleware — verifies Supabase JWT on every new connection.
 * Attaches userId, user, role, and ensures vault wallet exists.
 */
export async function authSocketMiddleware(socket, next) {
  try {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace('Bearer ', '').trim();

    if (!token) {
      logger.warn({ socketId: socket.id }, 'Socket auth failed — no token');
      return next(new Error('Authentication required'));
    }

    const user = await verifySupabaseToken(token);

    if (!user) {
      logger.warn({ socketId: socket.id }, 'Socket auth failed — invalid token');
      return next(new Error('Invalid or expired token'));
    }

    socket.userId = user.id;
    socket.user   = user;

    // Role is read ONLY from server-authoritative metadata.
    // Never from client-supplied handshake data to prevent privilege escalation.
    socket.role =
      user.app_metadata?.role ||
      user.user_metadata?.role ||
      'client';

    // Ensure user has appropriate vault wallet on connect.
    // Uses upsert with ignoreDuplicates to avoid race condition when two
    // socket connections authenticate simultaneously for the same user.
    const vaultType = socket.role === 'interpreter' ? 'interpreter' : 'client';
    const { error: walletErr } = await supabaseAdmin
      .from('wallets')
      .upsert(
        { user_id: user.id, vault_type: vaultType, balance: 0, currency: 'USD', reserved_balance: 0 },
        { onConflict: 'user_id,vault_type', ignoreDuplicates: true }
      );
    if (walletErr) {
      logger.warn({ userId: user.id, vaultType, err: walletErr }, 'Wallet upsert warning');
    }

    logger.info({ socketId: socket.id, userId: user.id, role: socket.role }, 'Socket authenticated');

    next();
  } catch (err) {
    logger.error({ err, socketId: socket.id }, 'Socket auth error');
    next(new Error('Authentication error'));
  }
}