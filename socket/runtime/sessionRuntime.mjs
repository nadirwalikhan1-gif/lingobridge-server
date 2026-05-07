/**
 * sessionRuntime.mjs
 * Tracks live session state in memory
 * Each entry: roomId → { clientSocketId, clientUserId, interpreterSocketId,
 *                        sessionId, reservedAmount, requestData }
 *
 * NOTE: This is intentionally in-memory.
 * Under Redis + multi-instance: stale session cron (60s) catches orphaned sessions.
 * For true multi-instance runtime state, migrate this to Redis hashes.
 */

// Map<roomId, RoomState>
const rooms = new Map();

// Map<socketId, Set<roomId>>
const socketToRooms = new Map();

export function addRoom(roomId, state) {
  rooms.set(roomId, state);
  _trackSocket(state.clientSocketId, roomId);
}

export function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

export function updateRoom(roomId, updates) {
  const room = rooms.get(roomId);
  if (!room) return;
  Object.assign(room, updates);
  if (updates.interpreterSocketId) {
    _trackSocket(updates.interpreterSocketId, roomId);
  }
}

export function deleteRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  // Clean up socket tracking
  _untrackSocket(room.clientSocketId, roomId);
  if (room.interpreterSocketId) _untrackSocket(room.interpreterSocketId, roomId);

  rooms.delete(roomId);
}

export function getRoomsForSocket(socketId) {
  return [...(socketToRooms.get(socketId) || new Set())];
}

export function getPendingRooms() {
  return [...rooms.entries()]
    .filter(([, room]) => !room.interpreterSocketId)
    .map(([roomId, room]) => ({ roomId, ...room.requestData }));
}

export function getRoomCount() {
  return rooms.size;
}

function _trackSocket(socketId, roomId) {
  if (!socketId) return;
  if (!socketToRooms.has(socketId)) socketToRooms.set(socketId, new Set());
  socketToRooms.get(socketId).add(roomId);
}

function _untrackSocket(socketId, roomId) {
  if (!socketId) return;
  socketToRooms.get(socketId)?.delete(roomId);
  if (socketToRooms.get(socketId)?.size === 0) socketToRooms.delete(socketId);
}
