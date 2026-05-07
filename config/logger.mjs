import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',

  // Pretty-print in development, JSON in production
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize:        true,
        translateTime:   'HH:MM:ss',
        ignore:          'pid,hostname',
        singleLine:      false,
      },
    },
  }),

  // Base fields attached to every log line
  base: {
    env: process.env.NODE_ENV || 'development',
  },

  // ISO timestamp
  timestamp: pino.stdTimeFunctions.isoTime,

  // Redact sensitive fields from logs
  redact: {
    paths: [
      'req.headers.authorization',
      'token',
      'password',
      'secret',
      'apiKey',
    ],
    censor: '[REDACTED]',
  },
});
