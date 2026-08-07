import { EventEmitter } from 'events';

/**
 * Internal event bus for decoupling services
 * Used for: session.ended, balance.exhausted
 * NOT for guaranteed delivery — in-memory only
 */
export const eventBus = new EventEmitter();
eventBus.setMaxListeners(50);

export const EVENTS = {
  SESSION_ENDED:          'session.ended',
  SESSION_FORCE_ENDED:    'session.force_ended',
  BALANCE_EXHAUSTED:      'session.balance_exhausted',
  WALLET_CREDITED:        'wallet.credited',
  RESERVATION_RELEASED:   'wallet.reservation_released',
  WALLET_TOPPED_UP:       'wallet.topped_up', // NEW — specifically real completed payments, distinct from WALLET_CREDITED (also fires on reservation releases)
  MESSAGE_SENT:           'message.sent', // NEW — real-time delivery notification, separate from the actual persistence (routes/v1.mjs still owns writing to the messages table; this just tells socket/index.mjs who to push to)
};
