import { logger } from '../config/logger.mjs';
import {
  getAvailableBalance,
  reserveFunds as reserveFundsRepo,
  releaseReservation as releaseRepo,
  creditWallet as creditWalletRepo,
} from '../db/walletRepo.mjs';
import { insertTransaction } from '../db/transactionRepo.mjs';

// FIX: was importing InsufficientBalanceError which didn't exist.
// errors.mjs now exports both names — InsufficientFundsError is canonical.
import { InsufficientFundsError } from '../utils/errors.mjs';
import { MINIMUM_BALANCE, RESERVATION_AMOUNT } from '../utils/constants.mjs';
import { audit, AUDIT_ACTIONS } from './auditService.mjs';
import { eventBus, EVENTS } from '../utils/eventBus.mjs';

/**
 * Check minimum balance before allowing call.
 */
export async function checkMinimumBalance(userId, currency, sessionType) {
  const { availableBalance } = await getAvailableBalance(userId);
  const minimum = MINIMUM_BALANCE[currency]?.[sessionType] ?? 6.00;

  if (availableBalance < minimum) {
    logger.warn({ userId, availableBalance, minimum }, 'Balance check failed');
    throw new InsufficientFundsError(
      `Minimum balance required: ${currency} ${minimum.toFixed(2)}`
    );
  }

  return availableBalance;
}

/**
 * Reserve funds for a call (called before session starts).
 */
export async function reserveFunds(userId, currency, sessionType) {
  const amount = RESERVATION_AMOUNT[currency]?.[sessionType] ?? 18.00;
  const result = await reserveFundsRepo(userId, amount);

  if (!result?.success) throw new InsufficientFundsError();

  await audit(userId, AUDIT_ACTIONS.RESERVATION_MADE, { amount, currency, sessionType });
  logger.info({ userId, amount, currency }, 'Funds reserved');
  return { reservedAmount: amount };
}

/**
 * Release reservation (call cancelled or timed out).
 */
export async function releaseReservation(userId, amount) {
  await releaseRepo(userId, amount);
  await audit(userId, AUDIT_ACTIONS.RESERVATION_RELEASED, { amount });
  logger.info({ userId, amount }, 'Reservation released');
}

/**
 * Credit wallet after successful payment.
 * Inserts a transaction record and emits WALLET_CREDITED event.
 * Called ONLY from paymentService — never from frontend.
 */
export async function addBalance(userId, amount, currency, description) {
  // Atomic increment via DB RPC — no race condition
  const updatedWallet = await creditWalletRepo(userId, amount);

  // Audit trail
  await insertTransaction({
    userId,
    amount,
    currency,
    type:        'top-up',
    description: description ?? `Wallet top-up — ${currency} ${amount}`,
  });

  await audit(userId, AUDIT_ACTIONS.WALLET_CREDITED, { amount, currency });

  // Emit internal event so socket layer can push balance to connected client
  eventBus.emit(EVENTS.WALLET_CREDITED, {
    userId,
    balance:          updatedWallet.balance,
    reservedBalance:  updatedWallet.reserved_balance,
    availableBalance: updatedWallet.balance - updatedWallet.reserved_balance,
    currency:         updatedWallet.currency,
  });

  logger.info({ userId, amount, currency }, 'Wallet credited');
  return updatedWallet;
}

/**
 * Get wallet summary for frontend display.
 */
export async function getWalletSummary(userId) {
  const { balance, reservedBalance, availableBalance, currency } =
    await getAvailableBalance(userId);
  return { balance, reservedBalance, availableBalance, currency };
}
