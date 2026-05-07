import { logger } from '../../config/logger.mjs';
import { generateAgoraToken } from '../../services/agoraService.mjs';
import { getRoom, updateRoom } from '../runtime/sessionRuntime.mjs';

export function acceptHandler(io, socket) {
  socket.on('accept-call', async (data) => {
    const { roomId } = data;
    const room = getRoom(roomId);

    if (!room) { socket.emit('call-cancelled'); return; }
    if (room.interpreterSocketId) { socket.emit('call-already-taken'); return; }

    try {
      updateRoom(roomId, { interpreterSocketId: socket.id });

      const channelName = room.requestData?.channelName || roomId;

      const [clientToken, interpToken] = await Promise.all([
        generateAgoraToken(channelName, 1, 'publisher'),
        generateAgoraToken(channelName, 2, 'publisher'),
      ]);

      socket.join(roomId);
      const clientSocket = io.sockets.sockets.get(room.clientSocketId);
      clientSocket?.join(roomId);

      io.to(room.clientSocketId).emit('call-accepted', {
        roomId,
        channelName,
        token: clientToken.token,
        uid:   1,
      });

      socket.emit('call-accepted', {
        roomId,
        channelName,
        token: interpToken.token,
        uid:   2,
      });

      logger.info({ roomId }, 'Call accepted');
    } catch (err) {
      logger.error({ err, roomId }, 'accept-call failed');
      socket.emit('error', { code: 'ACCEPT_FAILED', message: err.message });
    }
  });
}