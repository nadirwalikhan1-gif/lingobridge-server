import { Router } from 'express';
import { requireAuth } from '../middleware/authHttp.mjs';
import { createCheckout } from '../services/paymentService.mjs';
import { audit, AUDIT_ACTIONS } from '../services/auditService.mjs';
import { logger } from '../config/logger.mjs';

const router = Router();

/**
 * POST /create-checkout
 * Body: { amount: 10|25|50|100, currency: 'USD'|'GBP'|'CAD' }
 */
router.post('/', requireAuth, async (req, res) => {
  const { amount, currency = 'USD' } = req.body;
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

  try {
    const url = await createCheckout(userId, amount, currency);
    await audit(userId, AUDIT_ACTIONS.CHECKOUT_CREATED, { amount, currency });
    logger.info({ userId, amount, currency }, 'Checkout URL created');
    return res.status(200).json({ data: { url } });
  } catch (err) {
    logger.error({ err, userId }, 'Checkout creation failed');
    return res.status(400).json({ error: err.message });
  }
});

export default router;
