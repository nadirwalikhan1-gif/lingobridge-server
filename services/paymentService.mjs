import { lemonSqueezySetup, createCheckout as lsCreateCheckout } from '@lemonsqueezy/lemonsqueezy.js';
import { TOPUP_AMOUNTS, LEMON_VARIANTS } from '../utils/constants.mjs';
import { logger } from '../config/logger.mjs';

lemonSqueezySetup({ apiKey: process.env.LEMONSQUEEZY_API_KEY });

/**
 * Create a checkout URL for wallet top-up
 * @param {string} userId
 * @param {number} amount — must be in TOPUP_AMOUNTS
 * @param {string} currency
 */
export async function createCheckout(userId, amount, currency = 'USD') {
  if (!TOPUP_AMOUNTS.includes(amount)) {
    throw new Error(`Invalid top-up amount: ${amount}. Allowed: ${TOPUP_AMOUNTS.join(', ')}`);
  }

  const variantId = LEMON_VARIANTS.pro;
  if (!variantId) {
    throw new Error('LEMONSQUEEZY_VARIANT_ID_PRO is not configured');
  }

  const { data, error } = await lsCreateCheckout(
    process.env.LEMONSQUEEZY_STORE_ID,
    variantId,
    {
      checkoutData: {
        custom: {
          user_id:  userId,
          amount:   amount.toString(),
          currency,
        },
      },
    }
  );

  if (error) {
    logger.error({ error, userId, amount }, 'LemonSqueezy checkout creation failed');
    throw new Error(`Checkout failed: ${error.message}`);
  }

  return data?.data?.attributes?.url;
}import crypto from 'crypto';
import { addBalance } from './walletService.mjs';
import { claimWebhookEvent, releaseWebhookEventClaim } from '../db/webhookEventRepo.mjs';
import { eventBus, EVENTS } from '../utils/eventBus.mjs';
import { getUserById } from '../db/userRepo.mjs';

/**
 * Verify LemonSqueezy webhook signature
 */
export function verifyWebhookSignature(rawBody, signature) {
  if (!signature) return false;
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  if (!secret) return false;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody);
  const digest = hmac.digest('hex');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

/**
 * Process order_created webhook — credit user wallet.
 *
 * FIX: previously called the raw creditWallet(userId, amount, currency, orderId)
 * from db/walletRepo.mjs — wrong signature (currency landed in the vaultType
 * slot), and it skipped transaction logging, audit logging, and the
 * WALLET_CREDITED event entirely. Now uses services/walletService.mjs's
 * addBalance(), which does all of that correctly in one call.
 *
 * FIX: also adds real idempotency. LemonSqueezy retries on any non-2xx
 * response (by design, per this file's webhook.mjs caller) — without a
 * claim guard, a retried event could credit the same payment twice.
 */
export async function processOrderCreated(payload) {
  const custom   = payload?.meta?.custom_data;
  const userId   = custom?.user_id;
  const amount   = parseFloat(custom?.amount);
  const currency = custom?.currency ?? 'USD';
  const orderId  = payload?.data?.id;
  const eventId  = payload?.meta?.event_id ?? orderId;

  if (!userId || isNaN(amount)) {
    throw new Error('Missing user_id or amount in webhook payload');
  }

  const claimed = await claimWebhookEvent(eventId, payload?.meta?.event_name);
  if (!claimed) {
    logger.info({ eventId, userId }, 'Webhook event already processed — skipping duplicate');
    return { duplicate: true };
  }

  try {
    // This webhook only ever handles client wallet top-ups.
    await addBalance(userId, amount, currency, `Top-up — order ${orderId}`, 'client');

    const user = await getUserById(userId).catch(() => null);
    eventBus.emit(EVENTS.WALLET_TOPPED_UP, {
      userId,
      userName: user?.full_name ?? user?.email ?? userId,
      amount,
      currency,
    });

    return { success: true };
  } catch (err) {
    // Release the claim so a legitimate retry (this failure was transient,
    // not a duplicate) isn't permanently blocked from ever crediting.
    await releaseWebhookEventClaim(eventId).catch((cleanupErr) =>
      logger.error({ cleanupErr, eventId }, 'Failed to release webhook claim after credit failure')
    );
    throw err;
  }
}