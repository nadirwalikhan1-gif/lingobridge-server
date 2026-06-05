import { addParticipant, getParticipants, setRoomHold, isRoomOnHold } from '../runtime/sessionRuntime.mjs';

export function callInfoHandler(io, socket) {
  socket.on('call-user-info', ({ roomId, name, role }) => {
    if (!roomId || !name) return;
    
    // FIX: track participant in room state for 3-party labels
    addParticipant(roomId, { name, role, socketId: socket.id });
    
    socket.to(roomId).emit('call-user-info', { name, role });
  });

  // FIX: vault-model — broadcast current hold state when a party reconnects/refreshes
  socket.on('sync-hold-state', ({ roomId }) => {
    if (!roomId) return;
    
    const held = isRoomOnHold(roomId);
    if (held) {
      socket.emit('hold-session', {
        roomId,
        onHold: true,
        initiatorRole: 'unknown',
      });
    }
  });
}