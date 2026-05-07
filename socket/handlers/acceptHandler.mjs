import { logger } from '../../config/logger.mjs';
import { startSession } from '../../services/sessionService.mjs';
import { startBilling } from '../../services/billingService.mjs';
import { generateAgoraToken } from '../../services/agoraService.mjs';
import { getRoom, updateRoom } from '../runtime/sessionRuntime.mjs';
import { rateLimitSocket } from '../../middleware/rateLimiter.mjs';
import { validateEvent } from '../../middleware/validateEvent.mjs';
import { audit, AUDIT_ACTIONS } from '../../services/auditService.mjs';

export function acceptHandler(io, socket) {
  socket.on('accept-call', async (data) => {
    if (!rateLimitSocket(socket, 'accept-call')) return;

    const { valid, errors, sanitized } = validateEvent('accept-call', data);
    if (!valid) { socket.emit('error', { errors }); return; }

    const { roomId } = sanitized;
    const { userId } = socket;
    const room = getRoom(roomId);

    if (!room) { socket.emit('call-cancelled'); return; }
    if (room.interpreterSocketId) { socket.emit('call-already-taken'); return; }

    try {
      // Mark interpreter in runtime
      updateRoom(roomId, { interpreterSocketId: socket.id });

      // Generate Agora tokens server-side
      const channelName = room.requestData?.channelName || roomId;
      const [clientToken, interpToken] = await Promise.all([
        generateAgoraToken(channelName, 1, 'publisher'),
        generateAgoraToken(channelName, 2, 'publisher'),
      ]);

      // Activate session in DB
      const session = await startSession(room.sessionId, userId);

      // Join Socket.IO room
      socket.join(roomId);
      const clientSocket = io.sockets.sockets.get(room.clientSocketId);
      clientSocket?.join(roomId);

      const basePayload = {
        roomId,
        channelName,
        sessionId: room.sessionId,
        token:     null,
        uid:       null,
      };

      // Notify client
      io.to(room.clientSocketId).emit('call-accepted', {
        ...basePayload,
        token: clientToken.token,
        uid:   1,
      });

      // Notify interpreter
      socket.emit('call-accepted', {
        ...basePayload,
        token: interpToken.token,
        uid:   2,
      });

      // Start real-time billing
      startBilling(room.sessionId, io);

      await audit(userId, AUDIT_ACTIONS.CALL_STARTED, {
        roomId,
        sessionId: room.sessionId,
        role: 'interpreter',
      });

      logger.info({ roomId, sessionId: room.sessionId, userId }, 'Call accepted');

    } catch (err) {
      logger.error({ err, roomId, userId }, 'accept-call failed');
      socket.emit('error', { code: 'ACCEPT_FAILED', message: err.message });
    }
  });
}
