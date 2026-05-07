import { createClient } from 'redis';
import { logger } from './logger.mjs';

let redisClient   = null;
let redisReady    = false;

/**
 * Connect to Redis.
 * If REDIS_URL is not set or connection fails, the app continues
 * without Redis (Socket.IO falls back to in-memory adapter).
 */
export async function connectRedis() {
  const url = process.env.REDIS_URL;

  if (!url) {
    logger.warn('REDIS_URL not set — running without Redis (in-memory mode)');
    return;
  }

  redisClient = createClient({
    url,
    socket: {
      reconnectStrategy: (retries) => {
        if (retries > 5) {
          logger.error('Redis reconnect limit reached — giving up');
          return new Error('Redis reconnect limit reached');
        }
        const delay = Math.min(retries * 200, 2000);
        logger.warn({ retries, delay }, 'Redis reconnecting…');
        return delay;
      },
    },
  });

  redisClient.on('error',   (err) => logger.error({ err }, 'Redis client error'));
  redisClient.on('connect', ()    => logger.info('Redis connected'));
  redisClient.on('ready',   ()    => { redisReady = true;  logger.info('Redis ready'); });
  redisClient.on('end',     ()    => { redisReady = false; logger.warn('Redis connection closed'); });

  try {
    await redisClient.connect();
  } catch (err) {
    logger.error({ err }, 'Redis initial connection failed — continuing without Redis');
    redisClient = null;
    redisReady  = false;
  }
}

/**
 * Returns the connected Redis client instance.
 * Throws if Redis is not available — always check isRedisAvailable() first.
 */
export function getRedisClient() {
  if (!redisClient || !redisReady) {
    throw new Error('Redis client is not available');
  }
  return redisClient;
}

/**
 * Returns true when a Redis connection is live and ready.
 * Used by socket/index.mjs before attaching the Redis adapter.
 */
export function isRedisAvailable() {
  return redisReady && redisClient !== null;
}

/**
 * Gracefully disconnect Redis.
 * Called by shutdown.mjs during process teardown.
 */
export async function disconnectRedis() {
  if (redisClient) {
    await redisClient.quit().catch(() => {});
    redisReady = false;
    logger.info('Redis disconnected');
  }
}
