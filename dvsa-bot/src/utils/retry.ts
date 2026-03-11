import { createChildLogger } from './logger';

const log = createChildLogger('retry');

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  multiplier: number;
  maxDelayMs?: number;
  onRetry?: (error: Error, attempt: number) => void;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  multiplier: 3,
  maxDelayMs: 30000,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= opts.maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt > opts.maxRetries) {
        break;
      }

      const delay = Math.min(
        opts.baseDelayMs * Math.pow(opts.multiplier, attempt - 1),
        opts.maxDelayMs ?? Infinity
      );

      log.warn(
        { attempt, maxRetries: opts.maxRetries, delayMs: delay, error: lastError.message },
        'Retrying after error'
      );

      opts.onRetry?.(lastError, attempt);
      await sleep(delay);
    }
  }

  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
