import 'dotenv/config';
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import { logger } from './config/logger.mjs';
import { connectRedis } from './config/redis.mjs';
import { createSocketServer } from './socket/index.mjs';
import { startAllJobs } from './jobs/index.mjs';
import { registerShutdownHandlers } from './utils/shutdown.mjs';

import webhookRouter  from './routes/webhook.mjs';
import checkoutRouter from './routes/checkout.mjs';
import agoraRouter    from './routes/agora.mjs';
import healthRouter   from './routes/health.mjs';

const PORT            = process.env.PORT || 3001;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:5174').split(',');
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT_MS, 10) || 30000;

const app = express();

// ── REQUEST CONTEXT ──────────────────────────────────────────
// Inject request ID for distributed tracing across all logs
app.use((req, _res, next) => {
  req.id = req.headers['x-request-id'] || randomUUID();
  req.log = logger.child({ requestId: req.id });
  next();
});

// ── SECURITY ─────────────────────────────────────────────────
app.use(helmet());
app.set('trust proxy', 1);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    req.log.warn({ origin }, 'CORS blocked');
    cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST'],
}));

// TODO: For multi-instance deployments, swap to RedisStore:
// import { RedisStore } from 'rate-limit-redis';
app.use(rateLimit({
  windowMs: 60 * 1000,
  max:      100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    req.log.warn({ ip: req.ip }, 'Rate limit exceeded');
    res.status(429).json({ error: 'Too many requests — slow down' });
  },
}));

// ── BODY PARSERS ─────────────────────────────────────────────
// Raw body for webhook signature verification (MUST be before express.json)
app.use('/webhook', (req, res, next) => {
  let raw = '';
  let failed = false;
  req.setEncoding('utf8');

  req.on('data', (chunk) => {
    if (!failed) raw += chunk;
  });

  req.on('end', () => {
    if (!failed) {
      req.rawBody = raw;
      next();
    }
  });

  // FIX: Stream errors no longer hang the request
  req.on('error', (err) => {
    failed = true;
    req.log.error({ err }, 'Raw body stream error');
    if (!res.headersSent) {
      res.status(400).json({ error: 'Bad request' });
    }
  });
});

app.use(express.json({ limit: '512kb' }));

// ── ROUTES ───────────────────────────────────────────────────
app.use('/health',               healthRouter);
app.use('/webhook/lemonsqueezy', webhookRouter);
app.use('/create-checkout',      checkoutRouter);
app.use('/agora',                agoraRouter);

// 404 handler
app.use((req, res) => {
  req.log.warn({ path: req.path, method: req.method }, '404 Not found');
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  // FIX: Prevent "Cannot set headers after they are sent" crash
  if (res.headersSent) {
    req.log.error({ err }, 'Error after response sent');
    return next(err);
  }

  req.log.error({ err, path: req.path, method: req.method }, 'Unhandled route error');

  const isProd = process.env.NODE_ENV === 'production';
  res.status(err.statusCode || err.status || 500).json({
    error: isProd ? 'Internal server error' : (err.message || 'Internal server error'),
    ...(!isProd && { stack: err.stack }),
  });
});

// ── STARTUP ──────────────────────────────────────────────────
const httpServer = createServer(app);

// FIX: Prevent connections from hanging indefinitely
httpServer.requestTimeout = REQUEST_TIMEOUT;
httpServer.headersTimeout = REQUEST_TIMEOUT;

async function start() {
  await connectRedis();
  await createSocketServer(httpServer);
  startAllJobs();
  registerShutdownHandlers(httpServer);

  httpServer.listen(PORT, () => {
    logger.info(`Server running — http://localhost:${PORT}`);
    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });
}

start().catch((err) => {
  logger.fatal({ err }, 'Server failed to start');
  process.exit(1);
});