import { Server } from 'socket.io';
import { authSocketMiddleware } from '../middleware/authSocket.mjs';
import { requestHandler as registerHandler }  from './handlers/registerHandler.mjs';
import { requestHandler }   from './handlers/requestHandler.mjs';
import { acceptHandler }    from './handlers/acceptHandler.mjs';
import { endCallHandler }   from './handlers/endCallHandler.mjs';
import { logger }           from '../config/logger.mjs';
import { getRedisClient, isRedisAvailable } from '../config/redis.mjs';
import { eventBus, EVENTS } from '../utils/eventBus.mjs';
import { SOCKET_EVENTS }    from '../utils/constants.mjs';

export async function createSocketServer(httpServer) {
  // FIX: Match server.mjs CORS config exactly
  const isDev = process.env.NODE_ENV !== 'production';
  const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://lingobridge-client.vercel.app,http://localhost:5173,http://localhost:5174')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const io = new Server(httpServer, {
    cors: {
      // FIX: Allow all origins in dev, strict whitelist in production
      origin: (origin, callback) => {
        if (!origin || isDev || ALLOWED_ORIGINS.includes(origin) || origin.endsWith('.vercel.app')) {
       callback(null, true);
        } else {
          logger.warn({ origin, allowed: ALLOWED_ORIGINS }, 'Socket.IO CORS blocked');
          callback(new Error('Not allowed by CORS'));
        }
      },
      methods: ['GET', 'POST'],
      credentials: true, // FIX: Required for auth cookies/tokens
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
  io.use(authSocketMiddleware);

  // ── Connection ────────────────────────────────────────────
  io.on('connection', (socket) => {
    logger.info({ socketId: socket.id, userId: socket.userId }, 'Socket connected');

    registerHandler(io, socket);
    requestHandler(io, socket);
    acceptHandler(io, socket);
    endCallHandler(io, socket);
  });

  // ── Real-time wallet balance push ─────────────────────────
  eventBus.on(EVENTS.WALLET_CREDITED, ({ userId, balance, reservedBalance, availableBalance, currency }) => {
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