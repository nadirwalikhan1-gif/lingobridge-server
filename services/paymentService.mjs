import { lemonSqueezySetup, createCheckout as lsCreateCheckout } from '@lemonsqueezy/lemonsqueezy.js';
import { TOPUP_AMOUNTS, LEMON_VARIANTS } from '../utils/constants.mjs';
import { logger } from '../config/logger.mjs';

lemonSqueezySetup({ apiKey: process.env.LEMONSQUEEZY_API_KEY });

// FIX: base URL for the post-checkout redirect. Separate from
// ALLOWED_ORIGINS (server.mjs) on purpose — that's a CORS whitelist that
// can hold several comma-separated origins (prod, localhost, preview
// deploys), not a single canonical URL suitable for a redirect target.
const APP_URL = process.env.APP_URL || 'https://www.andiraw.com';

/**
 * Create a checkout URL for wallet top-up
 * @param {string} userId
 * @param {number} amount — must be in TOPUP_AMOUNTS
 * @param {string} currency
 * @param {string} [returnTo] — validated relative path (see routes/checkout.mjs)
 */
export async function createCheckout(userId, amount, currency = 'USD', returnTo) {
  const validAmounts = TOPUP_AMOUNTS[currency] ?? TOPUP_AMOUNTS.USD;
  if (!validAmounts.includes(amount)) {
    throw new Error(`Invalid top-up amount: ${amount}. Allowed: ${validAmounts.join(', ')}`);
  }

  const variantId = LEMON_VARIANTS[currency]?.[amount];
  if (!variantId) {
    throw new Error(`LemonSqueezy variant not configured for ${currency} $${amount}. Set LS_VARIANT_${currency}_${amount} in Railway.`);
  }

  // FIX: falls back to /client/dashboard when no valid returnTo was given,
  // but now honors wherever the person actually started (booking, wallet,
  // etc). ?checkout=success is a marker the frontend watches for on load —
  // the webhook that actually credits the wallet runs server-to-server,
  // independently of this browser redirect, so there's a real possibility
  // the redirect completes a moment before the webhook does. The marker
  // tells the frontend "you just paid — actively confirm the balance
  // landed" instead of trusting a single fetch-on-mount to have caught it.
  const path = returnTo || '/client/dashboard';
  const separator = path.includes('?') ? '&' : '?';
  const redirectUrl = `${APP_URL}${path}${separator}checkout=success`;

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
      productOptions: {
        redirectUrl,
        receiptButtonText: 'Go to Dashboard',
        receiptThankYouNote: "Your wallet has been topped up — you're ready to connect with an interpreter.",
      },
      // FIX: added now that checkout opens as an in-page overlay
      // (src/lib/lemonSqueezy.js) rather than a full-page redirect on most
      // browsers — embed:true trims chrome meant for a standalone checkout
      // page (redundant when it's already framed inside our own overlay).
      // redirectUrl above is still used as-is by the graceful fallback
      // path (plain window.location.href redirect) when Lemon.js can't
      // load, so it stays regardless of which path a given browser takes.
      checkoutOptions: {
        embed: true,
        media: false,
        logo: true,
      },
    }
  );

  if (error) {
    logger.error({ error, userId, amount }, 'LemonSqueezy checkout creation failed');
    throw new Error(`Checkout failed: ${error.message}`);
  }

  return data?.data?.attributes?.url;
}
import crypto from 'crypto';
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