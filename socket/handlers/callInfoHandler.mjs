export function callInfoHandler(io, socket) {
  socket.on('call-user-info', ({ roomId, name, role }) => {
    if (!roomId || !name) return
    socket.to(roomId).emit('call-user-info', { name, role })
  })
}