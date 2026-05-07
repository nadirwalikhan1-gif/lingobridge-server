import { logger } from '../../config/logger.mjs';
import { generateChannelName } from '../../services/agoraService.mjs';
import { addRoom, getRoom } from '../runtime/sessionRuntime.mjs';

export function requestHandler(io, socket) {
  socket.on('new-request', (data) => {
    const { roomId, language, type: sessionType, purpose } = data;

    if (getRoom(roomId)) return;

    const channelName = generateChannelName(roomId);

    addRoom(roomId, {
      clientSocketId:      socket.id,
      clientUserId:        socket.userId || 'demo-client',
      interpreterSocketId: null,
      sessionId:           null,
      requestData:         { ...data, channelName },
    });

    io.to('interpreters').emit('incoming-request', {
      ...data,
      roomId,
      channelName,
    });

    logger.info({ roomId }, 'Request broadcast to interpreters');

    setTimeout(() => {
      const room = getRoom(roomId);
      if (room && !room.interpreterSocketId) {
        socket.emit('no-interpreters');
      }
    }, 30000);
  });
}