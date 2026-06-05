import { logger } from '../config/logger.mjs';
import {
  getAvailableBalance,
  reserveFunds as reserveFundsRepo,
  releaseReservation as releaseRepo,
  creditWallet as creditWalletRepo,
} from '../db/walletRepo.mjs';
import { insertTransaction } from '../db/transactionRepo.mjs';

import { InsufficientFundsError } from '../utils/errors.mjs';
import { RESERVATION_AMOUNT, CLIENT_RATES } from '../utils/constants.mjs';
import { audit, AUDIT_ACTIONS } from './auditService.mjs';
import { eventBus, EVENTS } from '../utils/eventBus.mjs';

// USD-only minimums: one active minute of buffer
const MINIMUM_BALANCE = {
  USD: { audio: CLIENT_RATES.USD.audio, video: CLIENT_RATES.USD.video },
};

/**
 * Check minimum balance before allowing call.
 * Defaults to client vault — interpreters don't need this check.
 */
export async function checkMinimumBalance(userId, currency, sessionType, vaultType = 'client') {
  const { availableBalance } = await getAvailableBalance(userId, vaultType);
  const minimum = MINIMUM_BALANCE[currency]?.[sessionType] ?? 1.49;

  if (availableBalance < minimum) {
    logger.warn({ userId, availableBalance, minimum, vaultType }, 'Balance check failed');
    throw new InsufficientFundsError(
      `Minimum balance required: ${currency} ${minimum.toFixed(2)}`
    );
  }

  return availableBalance;
}

/**
 * Reserve funds for a call (called before session starts).
 * With vault model, reservations are $0 — kept for backward compatibility.
 */
export async function reserveFunds(userId, currency, sessionType, vaultType = 'client') {
  const amount = RESERVATION_AMOUNT[currency]?.[sessionType] ?? 0;
  if (amount <= 0) return { reservedAmount: 0 };

  const result = await reserveFundsRepo(userId, amount, vaultType);
  if (!result?.success) throw new InsufficientFundsError();

  await audit(userId, AUDIT_ACTIONS.RESERVATION_MADE, { amount, currency, sessionType, vaultType });
  logger.info({ userId, amount, currency, vaultType }, 'Funds reserved');
  return { reservedAmount: amount };
}

/**
 * Release reservation (call cancelled or timed out).
 */
export async function releaseReservation(userId, amount, vaultType = 'client') {
  if (amount <= 0) return;
  await releaseRepo(userId, amount, vaultType);
  await audit(userId, AUDIT_ACTIONS.RESERVATION_RELEASED, { amount, vaultType });
  logger.info({ userId, amount, vaultType }, 'Reservation released');
}

/**
 * Credit wallet after successful payment.
 * Vault-aware: defaults to client, but can credit interpreter vault too.
 */
export async function addBalance(userId, amount, currency, description, vaultType = 'client') {
  const updatedWallet = await creditWalletRepo(userId, amount, vaultType);

  await insertTransaction({
    userId,
    amount,
    currency,
    type:        'top-up',
    vaultType,
    description: description ?? `Wallet top-up — ${currency} ${amount}`,
  });

  await audit(userId, AUDIT_ACTIONS.WALLET_CREDITED, { amount, currency, vaultType });

  eventBus.emit(EVENTS.WALLET_CREDITED, {
    userId,
    vaultType,
    balance:          updatedWallet.balance,
    reservedBalance:  updatedWallet.reserved_balance,
    availableBalance: updatedWallet.balance - updatedWallet.reserved_balance,
    currency:         updatedWallet.currency,
  });

  logger.info({ userId, amount, currency, vaultType }, 'Wallet credited');
  return updatedWallet;
}

/**
 * Get wallet summary for frontend display.
 * Vault-aware: client sees their vault, interpreter sees earnings vault.
 */
export async function getWalletSummary(userId, vaultType = 'client') {
  const { balance, reservedBalance, availableBalance, currency } =
    await getAvailableBalance(userId, vaultType);
  return { balance, reservedBalance, availableBalance, currency, vaultType };
}