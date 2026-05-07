import { verifySupabaseToken } from '../config/supabase.mjs';
import { logger } from '../config/logger.mjs';

/**
 * HTTP middleware — verifies Supabase JWT for REST routes
 * Usage: router.post('/route', requireAuth, handler)
 */
export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  const token = authHeader.replace('Bearer ', '').trim();

  if (!token) {
    return res.status(401).json({ error: 'Token missing' });
  }

  const user = await verifySupabaseToken(token);

  if (!user) {
    logger.warn({ ip: req.ip }, 'HTTP auth failed — invalid token');
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.userId = user.id;
  req.user   = user;
  next();
}

/**
 * Optional auth — attaches user if token present, continues if not
 */
export async function optionalAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '').trim();
  if (token) {
    const user = await verifySupabaseToken(token);
    if (user) {
      req.userId = user.id;
      req.user   = user;
    }
  }
  next();
}
