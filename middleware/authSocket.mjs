import { verifySupabaseToken } from '../config/supabase.mjs';
import { logger } from '../config/logger.mjs';

/**
 * Socket.IO middleware — verifies Supabase JWT on every new connection.
 * Attaches userId, user, and role to the socket object.
 *
 * Usage: io.use(authSocketMiddleware)
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

    // FIX: Extract role from Supabase JWT metadata so index.mjs can
    // auto-join interpreters/admins rooms without waiting for 'register' event.
    // Supabase stores custom claims under user_metadata or app_metadata.
    socket.role =
      user.app_metadata?.role ||   // set via Supabase admin API (most reliable)
      user.user_metadata?.role ||  // set during signup
      socket.handshake.auth?.role || // fallback: client passes role in handshake
      'client';                    // default

    logger.info({ socketId: socket.id, userId: user.id, role: socket.role }, 'Socket authenticated');

    next();
  } catch (err) {
    logger.error({ err, socketId: socket.id }, 'Socket auth error');
    next(new Error('Authentication error'));
  }
}
