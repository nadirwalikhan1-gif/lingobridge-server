import { logger } from '../../config/logger.mjs';
import { generateChannelName } from '../../services/agoraService.mjs';
import { addRoom, getRoom } from '../runtime/sessionRuntime.mjs';
import { validateEvent } from '../../middleware/validateEvent.mjs';

export function requestHandler(io, socket) {
  socket.on('new-request', (data) => {
    // FIX: add validation for new-request event
    const { valid, errors, sanitized } = validateEvent('request-call', data);
    if (!valid) { socket.emit('error', { errors }); return; }

    const { roomId, language, type: sessionType, purpose } = sanitized;

    if (getRoom(roomId)) return;

    const channelName = generateChannelName(roomId);

    addRoom(roomId, {
      clientSocketId:      socket.id,
      clientUserId:        socket.userId || 'demo-client',
      interpreterSocketId: null,
      sessionId:           null,
      requestData:         { ...sanitized, channelName },
    });

    io.to('interpreters').emit('incoming-request', {
      ...sanitized,
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