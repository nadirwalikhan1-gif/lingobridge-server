import { logger }            from '../config/logger.mjs';
import { stopAllJobs }       from '../jobs/index.mjs';
import { stopAllBilling }    from '../services/billingService.mjs';
import { disconnectRedis }   from '../config/redis.mjs';

export function registerShutdownHandlers(httpServer) {
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'Shutdown signal received');

    // 1. Stop cron jobs
    stopAllJobs();

    // 2. Stop all in-memory billing loops
    stopAllBilling();

    // 3. Close HTTP server (stop accepting new connections)
    await new Promise((resolve) => httpServer.close(resolve));
    logger.info('HTTP server closed');

    // 4. Disconnect Redis
    await disconnectRedis();

    logger.info('Clean shutdown complete');
    process.exit(0);
  }

  // Force exit if graceful shutdown takes too long
  function forceExit() {
    setTimeout(() => {
      logger.warn('Graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 10_000).unref();
  }

  process.on('SIGTERM', () => { forceExit(); shutdown('SIGTERM'); });
  process.on('SIGINT',  () => { forceExit(); shutdown('SIGINT');  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    forceExit();
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'Unhandled promise rejection');
    forceExit();
    shutdown('unhandledRejection');
  });
}
