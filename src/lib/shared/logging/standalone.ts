/**
 * Standalone logger for contexts without Hono (Durable Objects, Workflows, Alarms, Queues).
 *
 * Provides structured JSON logging with request ID correlation and level filtering,
 * designed for non-HTTP contexts where the canonical log middleware doesn't apply.
 */

import { type LogLevel, shouldLog, getLogConfig } from './config.js';

export interface StandaloneLoggerOptions {
  /** Component name (e.g., 'SchedulerCoordinator', 'ExposureCheckWorkflow') */
  component: string;
  /** Request ID for correlation (use extractRequestId or generateContextId) */
  requestId?: string;
  /** Additional context fields to include in all log entries */
  baseContext?: Record<string, unknown>;
}

export interface StandaloneLogger {
  debug: (message: string, context?: Record<string, unknown>) => void;
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (message: string, context?: Record<string, unknown>) => void;
}

/**
 * Create a standalone logger for non-Hono contexts.
 *
 * The logger respects the global log level configuration (set via configureLogging).
 * All log entries include component name, request ID, and environment.
 */
export function createStandaloneLogger(options: StandaloneLoggerOptions): StandaloneLogger {
  const { component, requestId, baseContext = {} } = options;

  const logWithLevel = (level: LogLevel, message: string, context?: Record<string, unknown>): void => {
    if (!shouldLog(level)) return;

    const config = getLogConfig();
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      component,
      ...(requestId && { request_id: requestId }),
      environment: config.environment,
      service: config.service,
      ...baseContext,
      ...context,
    };

    // Remove undefined values for cleaner output
    const cleanEntry = Object.fromEntries(
      Object.entries(entry).filter(([, v]) => v !== undefined)
    );

    const json = JSON.stringify(cleanEntry);

    if (level === 'error') {
      console.error(json);
    } else {
      console.log(json);
    }
  };

  return {
    debug: (msg, ctx) => logWithLevel('debug', msg, ctx),
    info: (msg, ctx) => logWithLevel('info', msg, ctx),
    warn: (msg, ctx) => logWithLevel('warn', msg, ctx),
    error: (msg, ctx) => logWithLevel('error', msg, ctx),
  };
}

/**
 * Log an error with stack trace extraction.
 * Convenience function for error logging in standalone contexts.
 */
export function logStandaloneError(
  logger: StandaloneLogger,
  message: string,
  error: unknown,
  context?: Record<string, unknown>
): void {
  const errorContext = error instanceof Error
    ? {
        error_name: error.name,
        error_message: error.message,
        error_stack: error.stack,
      }
    : {
        error_message: String(error),
      };

  logger.error(message, {
    ...errorContext,
    ...context,
  });
}
