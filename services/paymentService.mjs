import { lemonSqueezySetup, createCheckout as lsCreateCheckout } from '@lemonsqueezy/lemonsqueezy.js';
import { TOPUP_AMOUNTS, LEMON_VARIANTS, DISCOUNT_PASS_PRICE_USD, DISCOUNT_PASS_PCT } from '../utils/constants.mjs';
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

/**
 * Create a checkout URL for the 30-day discount pass — a fixed $99
 * one-time charge, distinct from wallet top-ups (doesn't touch wallet
 * balance at all; db/discountPassRepo.mjs handles activation separately).
 *
 * REQUIRES: a real one-time-payment product created in the LemonSqueezy
 * dashboard for this specific $99 pass — this is NOT one of the existing
 * wallet top-up variants (LEMON_VARIANTS), those credit the wallet, this
 * doesn't. Set that product's variant ID as LEMONSQUEEZY_VARIANT_DISCOUNT_PASS
 * in Railway before this can create real checkouts.
 *
 * @param {string} userId
 * @param {string} [returnTo] — validated relative path (see routes/discountPass.mjs)
 */
export async function createDiscountPassCheckout(userId, returnTo) {
  const variantId = process.env.LEMONSQUEEZY_VARIANT_DISCOUNT_PASS;
  if (!variantId) {
    throw new Error('Discount pass checkout is not configured yet — set LEMONSQUEEZY_VARIANT_DISCOUNT_PASS in Railway.');
  }

  const path = returnTo || '/client/wallet';
  const separator = path.includes('?') ? '&' : '?';
  const redirectUrl = `${APP_URL}${path}${separator}checkout=success`;

  const { data, error } = await lsCreateCheckout(
    process.env.LEMONSQUEEZY_STORE_ID,
    variantId,
    {
      checkoutData: {
        custom: {
          user_id:  userId,
          amount:   DISCOUNT_PASS_PRICE_USD.toString(),
          currency: 'USD',
          // FIX: this is the field processOrderCreated below branches on
          // to tell a discount-pass purchase apart from a wallet top-up —
          // without it, the webhook would credit $99 straight into the
          // wallet instead of activating the pass.
          type: 'discount_pass',
        },
      },
      productOptions: {
        redirectUrl,
        receiptButtonText: 'Go to Dashboard',
        receiptThankYouNote: `Your ${DISCOUNT_PASS_PCT}% discount pass is active — enjoy reduced rates on every session for the next 30 days.`,
      },
      checkoutOptions: {
        embed: true,
        media: false,
        logo: true,
      },
    }
  );

  if (error) {
    logger.error({ error, userId }, 'LemonSqueezy discount pass checkout creation failed');
    throw new Error(`Checkout failed: ${error.message}`);
  }

  return data?.data?.attributes?.url;
}
import crypto from 'crypto';
import { addBalance } from './walletService.mjs';
import { claimWebhookEvent, releaseWebhookEventClaim } from '../db/webhookEventRepo.mjs';
import { eventBus, EVENTS } from '../utils/eventBus.mjs';
import { getUserById } from '../db/userRepo.mjs';
import { createDiscountPass } from '../db/discountPassRepo.mjs';
import { audit, AUDIT_ACTIONS } from './auditService.mjs';

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
 * Process order_created webhook — credit user wallet, or activate a
 * discount pass, depending on what was actually purchased.
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
 *
 * NEW: branches on custom.type. createDiscountPassCheckout above sets
 * type: 'discount_pass' specifically so this can tell a $99 discount pass
 * purchase apart from a wallet top-up — without that flag every discount
 * pass sale would incorrectly land as $99 of wallet credit instead of
 * activating the pass.
 */
export async function processOrderCreated(payload) {
  const custom   = payload?.meta?.custom_data;
  const userId   = custom?.user_id;
  const amount   = parseFloat(custom?.amount);
  const currency = custom?.currency ?? 'USD';
  const orderId  = payload?.data?.id;
  const eventId  = payload?.meta?.event_id ?? orderId;
  const isDiscountPass = custom?.type === 'discount_pass';

  if (!userId || isNaN(amount)) {
    throw new Error('Missing user_id or amount in webhook payload');
  }

  const claimed = await claimWebhookEvent(eventId, payload?.meta?.event_name);
  if (!claimed) {
    logger.info({ eventId, userId }, 'Webhook event already processed — skipping duplicate');
    return { duplicate: true };
  }

  try {
    if (isDiscountPass) {
      const pass = await createDiscountPass({
        userId,
        amountPaid: amount,
        currency,
        lemonsqueezyOrderId: orderId,
      });
      await audit(userId, AUDIT_ACTIONS.DISCOUNT_PASS_ACTIVATED, { orderId, expiresAt: pass.expires_at });
      logger.info({ userId, orderId, expiresAt: pass.expires_at }, 'Discount pass activated');
      return { success: true, type: 'discount_pass' };
    }

    // Wallet top-up path — unchanged.
    await addBalance(userId, amount, currency, `Top-up — order ${orderId}`, 'client');

    const user = await getUserById(userId).catch(() => null);
    eventBus.emit(EVENTS.WALLET_TOPPED_UP, {
      userId,
      userName: user?.full_name ?? user?.email ?? userId,
      amount,
      currency,
    });

    return { success: true, type: 'topup' };
  } catch (err) {
    // Release the claim so a legitimate retry (this failure was transient,
    // not a duplicate) isn't permanently blocked from ever crediting.
    await releaseWebhookEventClaim(eventId).catch((cleanupErr) =>
      logger.error({ cleanupErr, eventId }, 'Failed to release webhook claim after credit failure')
    );
    throw err;
  }
}