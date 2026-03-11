import pino from 'pino';
import { settings } from '../config/settings';

export const logger = pino({
  level: settings.logging.level,
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino/file', options: { destination: 1 } }
    : undefined,
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: {
    service: 'dvsa-bot',
  },
});

export function createChildLogger(component: string) {
  return logger.child({ component });
}
