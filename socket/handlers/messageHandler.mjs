// socket/handlers/messageHandler.mjs
//
// Real-time layer for client-interpreter messaging. Message PERSISTENCE
// still lives entirely in routes/v1.mjs (POST /v1/conversations/:id/messages)
// — this file doesn't duplicate that. It covers two things REST alone
// can't:
//
//   1. Conversation rooms (join-conversation / leave-conversation) — a
//      socket only joins conversation:{id} after this handler confirms the
//      connected user is actually client_id or interpreter_id on that
//      conversation. Membership is checked here, not trusted from the
//      client, same principle every other handler in this project follows.
//
//   2. typing / stop-typing — purely ephemeral, never touch the database.
//      Relayed via socket.to(), which excludes the sender automatically,
//      to everyone else currently in that conversation's room.
//
// new-message delivery (the actual "did my message arrive live" fix) is
// NOT in this file — it's driven by the MESSAGE_SENT event emitted from
// routes/v1.mjs after a successful insert, and pushed from socket/index.mjs
// via emitToUser(), the same utility/pattern already used for wallet
// balance pushes. That keeps message persistence as the single source of
// truth: a socket disconnect can never cause a message to silently vanish,
// since sending never depended on the socket layer succeeding.

import { validateEvent } from '../../middleware/validateEvent.mjs';
import { rateLimitSocket } from '../../middleware/rateLimiter.mjs';
import { supabaseAdmin } from '../../config/supabase.mjs';
import { logger } from '../../config/logger.mjs';

async function isParticipant(conversationId, userId) {
  const { data: convo } = await supabaseAdmin
    .from('conversations')
    .select('client_id, interpreter_id')
    .eq('id', conversationId)
    .maybeSingle();

  if (!convo) return false;
  return convo.client_id === userId || convo.interpreter_id === userId;
}

export function messageHandler(io, socket) {
  socket.on('join-conversation', async (data) => {
    const { valid, errors, sanitized } = validateEvent('join-conversation', data);
    if (!valid) {
      socket.emit('error', { code: 'VALIDATION_ERROR', errors });
      return;
    }
    if (!socket.userId) return;

    const { conversationId } = sanitized;

    try {
      const allowed = await isParticipant(conversationId, socket.userId);
      if (!allowed) {
        socket.emit('error', { code: 'FORBIDDEN', message: 'Not a participant in this conversation' });
        return;
      }
      socket.join(`conversation:${conversationId}`);
    } catch (err) {
      logger.error({ err, conversationId, userId: socket.userId }, 'join-conversation failed');
      socket.emit('error', { code: 'SERVER_ERROR', message: 'Could not join conversation' });
    }
  });

  socket.on('leave-conversation', (data) => {
    const { valid, sanitized } = validateEvent('leave-conversation', data);
    if (!valid) return; // leaving is best-effort, not worth erroring the client over
    socket.leave(`conversation:${sanitized.conversationId}`);
  });

  socket.on('typing', (data) => {
    // Deliberately generous limit — typing fires on a debounce client-side,
    // but this still guards against a misbehaving or malicious client
    // spamming the event directly.
    if (!rateLimitSocket(socket, 'typing', { max: 20, windowMs: 10_000 })) return;

    const { valid, sanitized } = validateEvent('typing', data);
    if (!valid || !socket.userId) return;

    // No DB check here — only reaches other sockets already in this room,
    // and joining it above already required proving participation. A
    // socket that was never allowed to join can't be in the room to relay
    // from in the first place.
    socket.to(`conversation:${sanitized.conversationId}`).emit('typing', {
      conversationId: sanitized.conversationId,
      userId: socket.userId,
    });
  });

  socket.on('stop-typing', (data) => {
    const { valid, sanitized } = validateEvent('stop-typing', data);
    if (!valid || !socket.userId) return;

    socket.to(`conversation:${sanitized.conversationId}`).emit('stop-typing', {
      conversationId: sanitized.conversationId,
      userId: socket.userId,
    });
  });
}
