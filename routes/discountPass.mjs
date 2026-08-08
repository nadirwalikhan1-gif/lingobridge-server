import { Router } from 'express';
import { requireAuth } from '../middleware/authHttp.mjs';
import { createDiscountPassCheckout } from '../services/paymentService.mjs';
import { getActiveDiscountPass } from '../db/discountPassRepo.mjs';
import { audit, AUDIT_ACTIONS } from '../services/auditService.mjs';
import { logger } from '../config/logger.mjs';

const router = Router();

// Same safe-relative-path validation as routes/checkout.mjs — prevents
// this being used as an open-redirect vector.
const isSafeRelativePath = (p) =>
  typeof p === 'string' &&
  p.startsWith('/') &&
  !p.startsWith('//') &&
  !/^\/\\/.test(p) &&
  !/^https?:/i.test(p);

/**
 * POST /discount-pass/checkout
 * Body: { returnTo?: string }
 */
router.post('/checkout', requireAuth, async (req, res) => {
  const { returnTo } = req.body;
  const userId = req.userId;
  const safeReturnTo = isSafeRelativePath(returnTo) ? returnTo : undefined;

  try {
    const url = await createDiscountPassCheckout(userId, safeReturnTo);
    await audit(userId, AUDIT_ACTIONS.CHECKOUT_CREATED, { type: 'discount_pass' });
    logger.info({ userId }, 'Discount pass checkout URL created');
    return res.status(200).json({ data: { url } });
  } catch (err) {
    logger.error({ err, userId }, 'Discount pass checkout creation failed');
    return res.status(400).json({ error: err.message });
  }
});

/**
 * GET /discount-pass/status
 * Returns whether the caller currently has an active pass, and its
 * discount percentage / expiry if so.
 */
router.get('/status', requireAuth, async (req, res) => {
  try {
    const pass = await getActiveDiscountPass(req.userId);
    res.json({
      data: pass
        ? { active: true, discountPct: pass.discount_pct, expiresAt: pass.expires_at }
        : { active: false },
    });
  } catch (err) {
    logger.error({ err, userId: req.userId }, 'Discount pass status fetch failed');
    res.json({ data: { active: false } });
  }
});

export default router;
