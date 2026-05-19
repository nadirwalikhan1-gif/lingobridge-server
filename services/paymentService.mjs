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
import { creditWallet } from '../db/walletRepo.mjs';

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
 * Process order_created webhook — credit user wallet
 */
export async function processOrderCreated(payload) {
  const custom   = payload?.meta?.custom_data;
  const userId   = custom?.user_id;
  const amount   = parseFloat(custom?.amount);
  const currency = custom?.currency ?? 'USD';
  const orderId  = payload?.data?.id;

  if (!userId || isNaN(amount)) {
    throw new Error('Missing user_id or amount in webhook payload');
  }

  await creditWallet(userId, amount, currency, orderId);
  return { success: true };
}