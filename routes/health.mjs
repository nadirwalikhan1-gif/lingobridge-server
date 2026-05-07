import { Router } from 'express';
import { getActiveBillingCount } from '../services/billingService.mjs';
import { getRoomCount } from '../socket/runtime/sessionRuntime.mjs';
import { isRedisAvailable } from '../config/redis.mjs';

const router = Router();

router.get('/', (req, res) => {
  res.json({
    status:         'ok',
    uptime:         Math.round(process.uptime()),
    env:            process.env.NODE_ENV || 'development',
    activeRooms:    getRoomCount(),
    activeBilling:  getActiveBillingCount(),
    redis:          isRedisAvailable(),
    timestamp:      new Date().toISOString(),
  });
});

export default router;
