import { createHmac } from 'crypto';
import { logger } from '../config/logger.mjs';
import { isWebhookProcessed, logWebhookEvent } from '../db/transactionRepo.mjs';
import { addBalance } from './walletService.mjs';

const LS_API_KEY   = process.env.LEMONSQUEEZY_API_KEY;
const LS_STORE_ID  = process.env.LEMONSQUEEZY_STORE_ID;
const LS_SECRET    = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5174';

// Variant IDs per currency/amount — configured in .env
const VARIANT_MAP = {
  USD: {
    10:  process.env.LS_VARIANT_USD_10,
    25:  process.env.LS_VARIANT_USD_25,
    50:  process.env.LS_VARIANT_USD_50,
    100: process.env.LS_VARIANT_USD_100,
  },
  GBP: {
    10:  process.env.LS_VARIANT_GBP_10,
    25:  process.env.LS_VARIANT_GBP_25,
    50:  process.env.LS_VARIANT_GBP_50,
    100: process.env.LS_VARIANT_GBP_100,
  },
  CAD: {
    10:  process.env.LS_VARIANT_CAD_10,
    25:  process.env.LS_VARIANT_CAD_25,
    50:  process.env.LS_VARIANT_CAD_50,
    100: process.env.LS_VARIANT_CAD_100,
  },
};

// ── SIGNATURE VERIFICATION ────────────────────────────────────

/**
 * Verify Lemon Squeezy webhook HMAC-SHA256 signature.
 * Rejects all requests in production if secret is not configured.
 */
export function verifyWebhookSignature(rawBody, signature) {
  if (!LS_SECRET) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('LEMONSQUEEZY_WEBHOOK_SECRET not set — rejecting webhook in production');
      return false;
    }
    logger.warn('Webhook secret not set — skipping verification (dev only)');
    return true;
  }

  if (!signature) return false;

  const digest = createHmac('sha256', LS_SECRET)
    .update(rawBody)
    .digest('hex');

  return digest === signature;
}

// ── CHECKOUT ─────────────────────────────────────────────────

/**
 * Create a Lemon Squeezy hosted checkout URL.
 * Called from /create-checkout route — user_id embedded in custom_data.
 */
export async function createCheckout(userId, amount, currency) {
  const validAmounts = [10, 25, 50, 100];
  const amt = Number(amount);

  if (!validAmounts.includes(amt)) {
    throw new Error('Invalid amount. Choose 10, 25, 50, or 100.');
  }

  const validCurrencies = ['USD', 'GBP', 'CAD'];
  if (!validCurrencies.includes(currency)) {
    throw new Error('Invalid currency. Choose USD, GBP, or CAD.');
  }

  const variantId = VARIANT_MAP[currency]?.[amt];
  if (!variantId) throw new Error('Variant not configured for this currency/amount');

  const response = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${LS_API_KEY}`,
      'Content-Type': 'application/vnd.api+json',
      Accept:         'application/vnd.api+json',
    },
    body: JSON.stringify({
      data: {
        type: 'checkouts',
        attributes: {
          checkout_data: {
            custom: {
              user_id:  userId,
              amount:   String(amt),
              currency,
            },
          },
          product_options: {
            redirect_url: `${FRONTEND_URL}/wallet?status=success`,
          },
        },
        relationships: {
          store:   { data: { type: 'stores',   id: LS_STORE_ID } },
          variant: { data: { type: 'variants', id: variantId   } },
        },
      },
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    logger.error({ err, status: response.status }, 'Lemon Squeezy checkout API error');
    throw new Error('Payment provider error — could not create checkout');
  }

  const json = await response.json();
  const url  = json?.data?.attributes?.url;
  if (!url) throw new Error('No checkout URL returned from Lemon Squeezy');
  return url;
}

// ── WEBHOOK PROCESSING ────────────────────────────────────────

/**
 * Process order_created event.
 *
 * Flow:
 *   1. Extract + validate payload fields
 *   2. Idempotency check (webhook_events table) — skip if duplicate
 *   3. Log webhook event (unique constraint is the race-condition safety net)
 *   4. Credit wallet atomically via DB RPC (no read-modify-write race)
 *      FIX: removed wallet_topups insert — that table does not exist in schema
 *      FIX: replaced fetch-then-update with atomic RPC via walletService.addBalance
 *   5. Real-time balance push via eventBus → socket layer
 *
 * @param {object} payload — parsed Lemon Squeezy webhook body
 */
export async function processOrderCreated(payload) {
  // ── 1. Extract fields ───────────────────────────────────────
  const order      = payload?.data?.attributes;
  const customData = payload?.meta?.custom_data;
  const eventId    = String(payload?.meta?.event_id ?? payload?.data?.id ?? '');
  const orderId    = String(payload?.data?.id ?? '');

  if (!order || !customData) {
    throw new Error('Malformed payload: missing data.attributes or meta.custom_data');
  }

  const userId   = customData.user_id;
  const amount   = parseFloat(customData.amount);
  const currency = customData.currency || 'USD';

  if (!userId)        throw new Error('Missing user_id in custom_data');
  if (!amount || amount <= 0) throw new Error('Invalid amount in custom_data');
  if (!eventId)       throw new Error('Missing event_id');

  // ── 2. Idempotency check ────────────────────────────────────
  const alreadyProcessed = await isWebhookProcessed(eventId);
  if (alreadyProcessed) {
    logger.warn({ eventId, orderId }, 'Duplicate webhook — skipping');
    return { duplicate: true };
  }

  // ── 3. Log webhook event ────────────────────────────────────
  // Insert first. Unique constraint on event_id is the last-resort race guard.
  const logged = await logWebhookEvent({ eventId, provider: 'lemonsqueezy', payload });
  if (!logged) {
    // Another process won the race and is handling this event
    logger.warn({ eventId }, 'Webhook log insert lost race — skipping');
    return { duplicate: true };
  }

  // ── 4. Credit wallet (atomic) + insert transaction record ───
  // addBalance() calls creditWallet RPC (balance = balance + amount, no race)
  // then inserts a transaction row and emits WALLET_CREDITED on eventBus.
  const updatedWallet = await addBalance(
    userId,
    amount,
    currency,
    `Wallet top-up — ${currency} ${amount} via Lemon Squeezy (order #${orderId})`
  );

  // ── 5. Done ─────────────────────────────────────────────────
  logger.info({ userId, amount, currency, orderId, eventId }, 'Wallet credited via webhook');
  return { success: true, balance: updatedWallet.balance };
}
