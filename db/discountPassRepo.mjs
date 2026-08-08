import { supabaseAdmin } from '../config/supabase.mjs';
import { DISCOUNT_PASS_DURATION_DAYS, DISCOUNT_PASS_PCT } from '../utils/constants.mjs';

const DURATION_MS = DISCOUNT_PASS_DURATION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Returns the client's currently active discount pass, or null.
 * "Active" means expires_at is in the future. A user can accumulate
 * several historical rows over time (each purchase is its own record for
 * a real audit trail), but only the one with the furthest-out expires_at
 * matters for "is there an active discount right now".
 */
export async function getActiveDiscountPass(userId) {
  const { data, error } = await supabaseAdmin
    .from('discount_passes')
    .select('*')
    .eq('user_id', userId)
    .gt('expires_at', new Date().toISOString())
    .order('expires_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`getActiveDiscountPass failed: ${error.message}`);
  return data;
}

/**
 * Records a new discount pass purchase.
 *
 * If the client already has time remaining on an active pass, the new
 * DISCOUNT_PASS_DURATION_DAYS is added on top of that remaining time
 * rather than replacing it — buying another pass while one is still
 * running shouldn't waste days left on the current one.
 */
export async function createDiscountPass({ userId, amountPaid, currency, lemonsqueezyOrderId, discountPct = DISCOUNT_PASS_PCT }) {
  const existing = await getActiveDiscountPass(userId);
  const base = existing ? new Date(existing.expires_at) : new Date();
  const expiresAt = new Date(base.getTime() + DURATION_MS);

  const { data, error } = await supabaseAdmin
    .from('discount_passes')
    .insert({
      user_id:               userId,
      discount_pct:          discountPct,
      expires_at:            expiresAt.toISOString(),
      amount_paid:           amountPaid,
      currency,
      lemonsqueezy_order_id: lemonsqueezyOrderId,
    })
    .select()
    .single();

  if (error) throw new Error(`createDiscountPass failed: ${error.message}`);
  return data;
}
