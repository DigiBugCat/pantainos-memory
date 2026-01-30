import { createStandaloneLogger } from './shared/logging/index.js';

/**
 * Options for retry behavior
 */
interface RetryOptions {
  /** Number of retry attempts (default: 2) */
  retries?: number;
  /** Delay between retries in ms (default: 100) */
  delay?: number;
  /** Operation name for logging */
  name?: string;
  /** Request ID for log correlation */
  requestId?: string;
}

/**
 * Execute a function with automatic retry on failure.
 * Useful for transient failures with external services (Vectorize, AI, etc.)
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { retries = 2, delay = 100, name = 'operation', requestId } = options;

  const log = createStandaloneLogger({
    component: 'Retry',
    requestId,
  });

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < retries) {
        log.warn('retry_attempt', {
          operation: name,
          attempt: attempt + 1,
          maxRetries: retries,
          error: lastError.message,
        });
        await sleep(delay);
      }
    }
  }

  // Log final failure
  log.error('retry_exhausted', {
    operation: name,
    attempts: retries + 1,
    error: lastError?.message,
  });

  throw lastError;
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
