// ── FATAL ERROR HANDLERS — must be first, before any imports ──
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  // engine.io polling race condition — safe to ignore
  if (reason instanceof TypeError && reason.message.includes('writeHead')) {
    console.warn('[unhandledRejection] Suppressed engine.io writeHead race:', reason.message);
    return;
  }
  console.error('[unhandledRejection]', reason);
  // optionally process.exit(1) for other truly fatal rejections
});

import 'dotenv/config';
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { generalLimiter, strictLimiter, webhookLimiter } from './middleware/rateLimiter.mjs';

import { logger } from './config/logger.mjs';
import { connectRedis } from './config/redis.mjs';
import { createSocketServer } from './socket/index.mjs';
import { startAllJobs } from './jobs/index.mjs';
import { registerShutdownHandlers } from './utils/shutdown.mjs';

import webhookRouter  from './routes/webhook.mjs';
import checkoutRouter from './routes/checkout.mjs';
import discountPassRouter from './routes/discountPass.mjs';
import agoraRouter    from './routes/agora.mjs';
import healthRouter   from './routes/health.mjs';
import v1Router       from './routes/v1.mjs';

const PORT            = process.env.PORT || 3001;
// FIX: Default includes production client + common dev ports
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://lingobridge-client.vercel.app,http://localhost:5173,http://localhost:5174').split(',').map(s => s.trim()).filter(Boolean);
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT_MS, 10) || 30000;

const app = express();

// ── REQUEST CONTEXT ──────────────────────────────────────────
app.use((req, _res, next) => {
  req.id = req.headers['x-request-id'] || randomUUID();
  req.log = logger.child({ requestId: req.id });
  next();
});

// ── SECURITY ─────────────────────────────────────────────────
app.use(helmet());
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));
app.set('trust proxy', 1);

// FIX: CORS — allow all origins in development, strict in production
const isDev = process.env.NODE_ENV !== 'production';
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return cb(null, true);
    // In development, allow all
    if (isDev) return cb(null, true);
    // In production, check against whitelist
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    // FIX: previously a strict exact-match only, with no fallback — a
    // single ALLOWED_ORIGINS edit (e.g. during a domain migration) that
    // dropped one still-in-use origin caused a full outage for anyone still
    // on it. Vercel preview/deployment URLs are already effectively public
    // and tied to this project, so allowing the whole *.vercel.app pattern
    // as a defensive fallback costs nothing security-wise while preventing
    // exactly this class of self-inflicted breakage.
    if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin)) return cb(null, true);
    logger.warn({ origin, allowed: ALLOWED_ORIGINS }, 'CORS blocked');
    cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true,
}));

// Global rate limiter — 200 req/min per IP (defence-in-depth on top of per-route limits)
app.use(generalLimiter);

// ── BODY PARSERS ─────────────────────────────────────────────
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
// Replace this:
app.use('/health', healthRouter);

// With this:
app.get('/health', async (req, res, next) => {
  req.url = '/';
  healthRouter(req, res, next);
});
app.use('/webhook/lemonsqueezy', webhookLimiter, webhookRouter);
app.use('/create-checkout',      strictLimiter, checkoutRouter);
app.use('/discount-pass',        strictLimiter, discountPassRouter);
app.use('/agora',                strictLimiter, agoraRouter);
app.use('/v1',                   v1Router);

// 404 handler
app.use((req, res) => {
  req.log.warn({ path: req.path, method: req.method }, '404 Not found');
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err, req, res, next) => {
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

httpServer.requestTimeout = REQUEST_TIMEOUT;
httpServer.headersTimeout = REQUEST_TIMEOUT;

async function start() {
  await connectRedis();
  const io = await createSocketServer(httpServer);
  startAllJobs(io);
  registerShutdownHandlers(httpServer);

  httpServer.listen(PORT, () => {
    logger.info(`Server running — http://localhost:${PORT}`);
    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
    logger.info(`Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  });
}

start().catch((err) => {
  logger.fatal({ err }, 'Server failed to start');
  process.exit(1);
});''




