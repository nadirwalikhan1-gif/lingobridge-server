import { verifySupabaseToken } from '../config/supabase.mjs';
import { logger } from '../config/logger.mjs';

/**
 * Socket.IO middleware — verifies Supabase JWT on every new connection.
 * Attaches userId and user to the socket object.
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
    next();
  } catch (err) {
    logger.error({ err, socketId: socket.id }, 'Socket auth error');
    next(new Error('Authentication error'));
  }
}
