import { Server } from 'socket.io';
import { authSocketMiddleware } from '../middleware/authSocket.mjs';
import { registerHandler }  from './handlers/registerHandler.mjs';
import { requestHandler }   from './handlers/requestHandler.mjs';
import { acceptHandler }    from './handlers/acceptHandler.mjs';
import { endCallHandler }   from './handlers/endCallHandler.mjs';
import { logger }           from '../config/logger.mjs';
import { getRedisClient, isRedisAvailable } from '../config/redis.mjs';
import { eventBus, EVENTS } from '../utils/eventBus.mjs';
import { SOCKET_EVENTS }    from '../utils/constants.mjs';

export async function createSocketServer(httpServer) {
 const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://lingobridge-tau.vercel.app').split(',');
  const io = new Server(httpServer, {
    cors: {
      origin:  ALLOWED_ORIGINS,
      methods: ['GET', 'POST'],
    },
    pingTimeout:  20000,
    pingInterval: 10000,
  });

  // ── Redis adapter (optional) ──────────────────────────────
  if (isRedisAvailable()) {
    try {
      const { createAdapter } = await import('@socket.io/redis-adapter');
      const pubClient = getRedisClient();
      const subClient = pubClient.duplicate();
      await subClient.connect();
      io.adapter(createAdapter(pubClient, subClient));
      logger.info('Socket.IO using Redis adapter');
    } catch (err) {
      logger.warn({ err }, 'Redis adapter setup failed — using in-memory');
    }
  }

  // ── Auth middleware ───────────────────────────────────────
    // // // // io.use(authSocketMiddleware);
  // ── Connection ────────────────────────────────────────────
  io.on('connection', (socket) => {
    logger.info({ socketId: socket.id, userId: socket.userId }, 'Socket connected');

    registerHandler(io, socket);
    requestHandler(io, socket);
    acceptHandler(io, socket);
    endCallHandler(io, socket);
  });

  // ── Real-time wallet balance push ─────────────────────────
  // When paymentService credits a wallet, eventBus emits WALLET_CREDITED.
  // We find the socket(s) for that userId and push the updated balance.
  // This works for single-instance. For multi-instance + Redis adapter,
  // replace with io.serverSideEmit or a Redis pub/sub channel.
  eventBus.on(EVENTS.WALLET_CREDITED, ({ userId, balance, reservedBalance, availableBalance, currency }) => {
    // Find all sockets belonging to this user
    let pushed = 0;
    for (const [, socket] of io.sockets.sockets) {
      if (socket.userId === userId) {
        socket.emit(SOCKET_EVENTS.BALANCE_UPDATE, {
          balance,
          reservedBalance,
          availableBalance,
          currency,
        });
        pushed += 1;
      }
    }
    logger.info({ userId, balance, pushed }, 'Wallet balance pushed to connected socket(s)');
  });

  return io;
}
