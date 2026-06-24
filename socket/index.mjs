import { registerAdminHandlers } from './handlers/adminHandler.mjs';
import { Server } from 'socket.io';
import { authSocketMiddleware } from '../middleware/authSocket.mjs';
import { requestHandler as registerHandler }  from './handlers/registerHandler.mjs';
import { requestHandler }   from './handlers/requestHandler.mjs';
import { acceptHandler }    from './handlers/acceptHandler.mjs';
import { endCallHandler }   from './handlers/endCallHandler.mjs';
import { callInfoHandler } from './handlers/callInfoHandler.mjs';
import { registerSessionHandlers } from './handlers/sessionHandlers.mjs'; // NEW
import { interpreterDashboardHandler } from './handlers/interpreterDashboardHandler.mjs'; // NEW
import { logger }           from '../config/logger.mjs';
import { getRedisClient, isRedisAvailable } from '../config/redis.mjs';
import { eventBus, EVENTS } from '../utils/eventBus.mjs';
import { SOCKET_EVENTS }    from '../utils/constants.mjs';
import { getPendingRooms }  from './runtime/sessionRuntime.mjs';
import { billingTick, holdBillingTick } from '../services/billingService.mjs'; // NEW

export async function createSocketServer(httpServer) {
  const isDev = process.env.NODE_ENV !== 'production';
  const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://lingobridge-client.vercel.app,http://localhost:5173,http://localhost:5174')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        try {
          if (!origin || isDev || ALLOWED_ORIGINS.includes(origin) || origin.endsWith('.vercel.app')) {
            callback(null, true);
          } else {
            logger.warn({ origin, allowed: ALLOWED_ORIGINS }, 'Socket.IO CORS blocked');
            callback(new Error('Not allowed by CORS'));
          }
        } catch (e) {
          callback(null, true);
        }
      },
      methods: ['GET', 'POST'],
      credentials: true,
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
    registerAdminHandlers(io, socket);
    const role = socket.role; // set by authSocketMiddleware
    logger.info({ socketId: socket.id, userId: socket.userId, role }, 'Socket connected');

    // FIX: Join role-based rooms immediately on connect (before any 'register' event)
    if (role === 'interpreter') {
      socket.join('interpreters');
      socket.interpreterRole = true;
      logger.info({ userId: socket.userId }, 'Interpreter auto-joined interpreters room');

      const pending = getPendingRooms();
      if (pending.length > 0) {
        socket.emit('pending-requests', pending);
        logger.info({ userId: socket.userId, count: pending.length }, 'Replayed pending requests to interpreter');
      }
    }

    if (role === 'admin') {
      socket.join('admins');
      logger.info({ userId: socket.userId }, 'Admin auto-joined admins room');

      const pending = getPendingRooms();
      if (pending.length > 0) {
        socket.emit('pending-requests', pending);
      }
    }

    if (role === 'client') {
      socket.clientRole = true;
    }

    registerHandler(io, socket);
    requestHandler(io, socket);
    acceptHandler(io, socket);
    endCallHandler(io, socket);
    callInfoHandler(io, socket);
    registerSessionHandlers(io, socket); // NEW
    interpreterDashboardHandler(io, socket); // NEW
  });

  // ── Real-time wallet balance push ─────────────────────────
  eventBus.on(EVENTS.WALLET_CREDITED, async ({ userId, balance, reservedBalance, availableBalance, currency }) => {
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

  // ── Admin notification on genuine wallet top-up ───────────────
  // Distinct from WALLET_CREDITED above, which also fires on reservation
  // releases — this only fires for actual completed payments.
  eventBus.on(EVENTS.WALLET_TOPPED_UP, ({ userId, userName, amount, currency }) => {
    io.to('admins').emit('wallet-topped-up', {
      id:       `topup-${userId}-${Date.now()}`,
      severity: 'info',
      title:    'Wallet top-up',
      detail:   `${userName} added ${currency} ${amount}`,
      time:     new Date().toISOString(),
    });
  });

  // NEW: Start vault-model billing loops
  setInterval(billingTick, 60_000);
  setInterval(holdBillingTick, 60_000);
  logger.info('Billing loops started: active (60s) + hold (60s)');

  return io;
}