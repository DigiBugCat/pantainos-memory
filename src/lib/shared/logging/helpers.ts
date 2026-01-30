/**
 * Helper functions for logging in route handlers.
 * Provides convenient ways to add context and track operations.
 */

import type { Context } from 'hono';
import { getLogContext, getRequestId } from './middleware.js';
import { logger } from './logger.js';
import type { LogContext } from './context.js';

/**
 * Add a field to the request's log context.
 * Use for business context: ticker, user_id, event_type, etc.
 */
export function logField(c: Context, key: string, value: unknown): void {
  const ctx = getLogContext(c);
  if (ctx) {
    ctx.addField(key, value);
  }
}

/**
 * Add multiple fields to the request's log context.
 */
export function logFields(c: Context, fields: Record<string, unknown>): void {
  const ctx = getLogContext(c);
  if (ctx) {
    ctx.addFields(fields);
  }
}

/**
 * Record an operation for the audit trail.
 * Use for significant actions: db operations, API calls, queue dispatches.
 */
export function logOperation(
  c: Context,
  op: string,
  target: string,
  options?: {
    entity_id?: string;
    duration_ms?: number;
    success?: boolean;
    detail?: string;
  }
): void {
  const ctx = getLogContext(c);
  if (ctx) {
    ctx.operation(op, target, options);
  }
}

/**
 * Helper to time an operation and log it.
 * Returns the operation result.
 */
export async function timedOperation<T>(
  c: Context,
  op: string,
  target: string,
  fn: () => Promise<T>,
  options?: {
    entity_id?: string;
    detail?: string;
  }
): Promise<T> {
  const start = Date.now();
  let success = true;

  try {
    return await fn();
  } catch (error) {
    success = false;
    throw error;
  } finally {
    const duration_ms = Date.now() - start;
    logOperation(c, op, target, {
      ...options,
      duration_ms,
      success,
    });
  }
}

/**
 * Get the request ID for the current request.
 * Useful for passing to downstream services or including in responses.
 */
export function getReqId(c: Context): string {
  return getRequestId(c) ?? 'unknown';
}

/**
 * Get the log context directly for advanced usage.
 * Prefer using logField, logOperation helpers for most cases.
 *
 * @deprecated Use `getLogContext(c)` from middleware instead.
 * This is just an alias that adds no value.
 */
export function getLog(c: Context): LogContext | undefined {
  return getLogContext(c);
}

/**
 * Log an event outside of request context (scheduled jobs, queue handlers).
 *
 * @deprecated Use `createStandaloneLogger()` instead for better structured logging
 * with component context and request ID correlation.
 */
export function logEvent(event: string, context?: Record<string, unknown>): void {
  logger.info(event, context);
}

/**
 * Log an error outside of request context.
 *
 * @deprecated Use `createStandaloneLogger()` with `logStandaloneError()` instead
 * for better structured logging with component context and request ID correlation.
 */
export function logError(
  event: string,
  error: Error | string,
  context?: Record<string, unknown>
): void {
  const errorDetail =
    error instanceof Error
      ? {
          error_name: error.name,
          error_message: error.message,
          error_stack: error.stack,
        }
      : { error_message: error };

  logger.error(event, {
    ...errorDetail,
    ...context,
  });
}
