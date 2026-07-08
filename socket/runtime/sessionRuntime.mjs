/**
 * sessionRuntime.mjs
 * Tracks live session state in memory
 * Each entry: roomId → { clientSocketId, clientUserId, interpreterSocketId,
 *                        sessionId, reservedAmount, requestData, participants, onHold }
 *
 * NOTE: This is intentionally in-memory.
 * Under Redis + multi-instance: stale session cron (60s) catches orphaned sessions.
 */

// Map<roomId, RoomState>
const rooms = new Map();

// Map<socketId, Set<roomId>>
const socketToRooms = new Map();

export function addRoom(roomId, state) {
  rooms.set(roomId, {
    ...state,
    participants: [], // FIX: 3-party participant tracking
    onHold: false,  // FIX: hold state mirror
  });
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

// FIX: double-booking race — claimRoom() does the "is it taken?" check and
// the "claim it" write as a single synchronous operation (safe by virtue of
// JS's single-threaded event loop: nothing else can run between the check
// and the set within one function call, unlike the previous pattern of
// checking via getRoom() and only claiming after a chain of awaits, which
// left a real window for two concurrent accept-call events to both pass the
// check). This is a same-process fast path only — see the multi-instance
// note at the top of this file — the authoritative guard against races
// across instances is the DB-level claimSessionForInterpreter() in
// sessionRepo.mjs, which acceptHandler.mjs also checks.
export function claimRoom(roomId, socketId, interpreterUserId) {
  const room = rooms.get(roomId);
  if (!room || room.interpreterSocketId) return false;
  room.interpreterSocketId = socketId;
  room.interpreterUserId = interpreterUserId;
  _trackSocket(socketId, roomId);
  return true;
}

// Releases a claim made by claimRoom() above — used when the DB-level claim
// in acceptHandler.mjs subsequently fails, so the room can still be won by
// someone else instead of being stuck falsely "taken" forever.
export function releaseClaim(roomId, socketId) {
  const room = rooms.get(roomId);
  if (!room || room.interpreterSocketId !== socketId) return;
  room.interpreterSocketId = null;
  room.interpreterUserId = null;
  _untrackSocket(socketId, roomId);
}

export function deleteRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

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

// Added for the request-timeout job — returns full room state (sessionId,
// clientUserId, reservedAmount etc), not just requestData. getPendingRooms()
// above is left untouched since it's already used by registerHandler.mjs,
// adminHandler.mjs, and socket/index.mjs.
export function getPendingRoomsFull() {
  return [...rooms.entries()]
    .filter(([, room]) => !room.interpreterSocketId)
    .map(([roomId, room]) => ({ roomId, ...room }));
}

export function getRoomCount() {
  return rooms.size;
}

// FIX: 3-party participant management
export function addParticipant(roomId, participant) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (!room.participants.find(p => p.name === participant.name && p.role === participant.role)) {
    room.participants.push(participant);
  }
}

export function getParticipants(roomId) {
  return rooms.get(roomId)?.participants || [];
}

// FIX: hold state management
export function setRoomHold(roomId, onHold) {
  const room = rooms.get(roomId);
  if (room) room.onHold = onHold;
}

export function isRoomOnHold(roomId) {
  return rooms.get(roomId)?.onHold || false;
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