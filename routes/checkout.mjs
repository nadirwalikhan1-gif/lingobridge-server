import { Router } from 'express';
import { requireAuth } from '../middleware/authHttp.mjs';
import { createCheckout } from '../services/paymentService.mjs';
import { audit, AUDIT_ACTIONS } from '../services/auditService.mjs';
import { logger } from '../config/logger.mjs';

const router = Router();

/**
 * POST /create-checkout
 * Body: { amount: 10|25|50|100, currency: 'USD'|'GBP'|'CAD', returnTo?: string }
 */
router.post('/', requireAuth, async (req, res) => {
  const { amount, currency = 'USD', returnTo } = req.body;
  const userId = req.userId;

  // Input validation — prevent garbage amounts reaching the payment provider
  const VALID_AMOUNTS   = [10, 25, 50, 100];
  const VALID_CURRENCIES = ['USD', 'GBP', 'CAD'];

  if (!VALID_AMOUNTS.includes(Number(amount))) {
    return res.status(400).json({
      error: `Invalid amount. Must be one of: ${VALID_AMOUNTS.join(', ')}`,
    });
  }

  if (!VALID_CURRENCIES.includes(String(currency).toUpperCase())) {
    return res.status(400).json({
      error: `Invalid currency. Must be one of: ${VALID_CURRENCIES.join(', ')}`,
    });
  }

  // FIX: returnTo lets the person land back on whichever page they actually
  // started from (booking, wallet, dashboard) instead of always landing on
  // /client/dashboard regardless of where the "Add funds" click came from —
  // previously someone topping up mid-booking would return to a blank
  // dashboard with no path back to their in-progress booking.
  // Must be a same-origin relative path — reject anything that could be
  // used as an open-redirect vector (protocol-relative //, absolute
  // http(s):// URLs, backslash tricks).
  const isSafeRelativePath = (p) =>
    typeof p === 'string' &&
    p.startsWith('/') &&
    !p.startsWith('//') &&
    !/^\/\\/.test(p) &&
    !/^https?:/i.test(p);
  const safeReturnTo = isSafeRelativePath(returnTo) ? returnTo : undefined;

  try {
    const url = await createCheckout(userId, amount, currency, safeReturnTo);
    await audit(userId, AUDIT_ACTIONS.CHECKOUT_CREATED, { amount, currency });
    logger.info({ userId, amount, currency, returnTo: safeReturnTo }, 'Checkout URL created');
    return res.status(200).json({ data: { url } });
  } catch (err) {
    logger.error({ err, userId }, 'Checkout creation failed');
    return res.status(400).json({ error: err.message });
  }
});

export default router;
