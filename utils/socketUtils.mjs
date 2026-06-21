// utils/socketUtils.mjs
//
// Reuses the same pattern already established in socket/index.mjs's
// WALLET_CREDITED listener (iterate connected sockets, match by userId) —
// there's no per-user room join on connect, so this is the existing
// convention for targeting a specific user from outside their own request
// handler (e.g. from a background job).

export function emitToUser(io, userId, event, payload) {
  let pushed = 0;
  for (const [, socket] of io.sockets.sockets) {
    if (socket.userId === userId) {
      socket.emit(event, payload);
      pushed += 1;
    }
  }
  return pushed;
}
