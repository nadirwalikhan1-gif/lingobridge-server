import { Router } from 'express';
import { getActiveBillingCount } from '../services/billingService.mjs';
import { getRoomCount } from '../socket/runtime/sessionRuntime.mjs';
import { isRedisAvailable } from '../config/redis.mjs';
import { supabaseAdmin } from '../config/supabase.mjs';

const router = Router();

router.get('/', async (req, res) => {
  // FIX: add Supabase connectivity check
  let supabaseHealthy = false;
  try {
    const { error } = await supabaseAdmin.from('users').select('id').limit(1);
    supabaseHealthy = !error;
  } catch {
    supabaseHealthy = false;
  }

  res.json({
    status:         'ok',
    uptime:         Math.round(process.uptime()),
    env:            process.env.NODE_ENV || 'development',
    activeRooms:    getRoomCount(),
    activeBilling:  getActiveBillingCount(),
    redis:          isRedisAvailable(),
    supabase:       supabaseHealthy,
    timestamp:      new Date().toISOString(),
  });
});

export default router;