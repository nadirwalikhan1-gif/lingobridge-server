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

  try {
    const url = await createCheckout(userId, amount, currency);
    await audit(userId, AUDIT_ACTIONS.CHECKOUT_CREATED, { amount, currency });
    logger.info({ userId, amount, currency }, 'Checkout URL created');
    return res.status(200).json({ url });
  } catch (err) {
    logger.error({ err, userId }, 'Checkout creation failed');
    return res.status(400).json({ error: err.message });
  }
});

export default router;
