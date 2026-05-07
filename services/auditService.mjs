import { supabaseAdmin } from '../config/supabase.mjs';
import { logger } from '../config/logger.mjs';

/**
 * Write an audit log entry
 * Non-blocking — failures are logged but don't throw
 */
export async function audit(userId, action, metadata = {}) {
  const { error } = await supabaseAdmin
    .from('audit_logs')
    .insert({
      user_id:  userId,
      action,
      metadata,
      created_at: new Date().toISOString(),
    });

  if (error) {
    logger.warn({ error, userId, action }, 'Audit log failed');
  }
}

export const AUDIT_ACTIONS = {
  CALL_STARTED:        'call.started',
  CALL_ENDED:          'call.ended',
  CALL_FORCE_ENDED:    'call.force_ended',
  WALLET_CREDITED:     'wallet.credited',
  WALLET_DEDUCTED:     'wallet.deducted',
  RESERVATION_MADE:    'wallet.reserved',
  RESERVATION_RELEASED:'wallet.reservation_released',
  CHECKOUT_CREATED:    'payment.checkout_created',
  WEBHOOK_RECEIVED:    'payment.webhook_received',
  AUTH_LOGIN:          'auth.login',
  AUTH_LOGOUT:         'auth.logout',
};
