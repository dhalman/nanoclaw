import fs from 'fs';
import path from 'path';
import pino from 'pino';

const buildId = (() => {
  try {
    return fs
      .readFileSync(
        path.join(process.cwd(), 'container/ollama-runner/build-id.txt'),
        'utf-8',
      )
      .trim();
  } catch {
    return '?';
  }
})();

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
  base: { version: buildId },
});

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
