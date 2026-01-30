/**
 * Hono middleware for canonical log line emission.
 * Extracts or generates request ID, initializes log context, emits at completion.
 *
 * Supports cross-service tracing by honoring incoming X-Request-ID header.
 */

import type { MiddlewareHandler, Context } from 'hono';
import { createLogContext, type LogContext } from './context.js';
import { extractRequestId as extractFromRequest } from './tracing.js';

// Keys for storing context in Hono's context
const LOG_CONTEXT_KEY = 'logContext';
const REQUEST_ID_KEY = 'requestId';

/**
 * Sensitive parameter names that should be masked in logs.
 * Case-insensitive matching is used.
 */
const SENSITIVE_PARAMS = new Set([
  // Authentication
  'password',
  'passwd',
  'pass',
  'secret',
  'token',
  'api_key',
  'apikey',
  'api-key',
  'access_token',
  'refresh_token',
  'auth',
  'authorization',
  'bearer',
  'credential',
  'credentials',
  // Personal data
  'ssn',
  'social_security',
  'credit_card',
  'card_number',
  'cvv',
  'pin',
  // OAuth
  'client_secret',
  'code',
  'state',
]);

/**
 * Mask value for redacted parameters.
 */
const REDACTED = '[REDACTED]';

/**
 * Check if a parameter name is sensitive.
 */
function isSensitiveParam(key: string): boolean {
  const lowerKey = key.toLowerCase();
  return SENSITIVE_PARAMS.has(lowerKey);
}

/**
 * Sanitize a value for logging.
 * Sensitive values are masked, others are truncated if too long.
 */
function sanitizeValue(key: string, value: string): string {
  if (isSensitiveParam(key)) {
    return REDACTED;
  }
  // Truncate very long values to prevent log bloat
  const MAX_VALUE_LENGTH = 200;
  if (value.length > MAX_VALUE_LENGTH) {
    return value.slice(0, MAX_VALUE_LENGTH) + '...[truncated]';
  }
  return value;
}

export interface CanonicalLogMiddlewareOptions {
  /** Service name (e.g., "cassandra-scheduler") */
  service: string;
  /** Custom request ID extraction (default: from X-Request-ID header or generate) */
  extractRequestId?: (request: Request) => string;
  /** Additional sensitive parameter names to mask */
  additionalSensitiveParams?: string[];
}

/**
 * Extract query parameters as a record, sanitizing sensitive values.
 */
function extractQuery(c: Context, additionalSensitive?: string[]): Record<string, string> | undefined {
  const url = new URL(c.req.url);
  const params: Record<string, string> = {};

  // Add any additional sensitive params
  if (additionalSensitive) {
    additionalSensitive.forEach((param) => SENSITIVE_PARAMS.add(param.toLowerCase()));
  }

  url.searchParams.forEach((value, key) => {
    params[key] = sanitizeValue(key, value);
  });
  return Object.keys(params).length > 0 ? params : undefined;
}

/**
 * Extract route params as a record.
 */
function extractParams(c: Context): Record<string, string> | undefined {
  const params = c.req.param();
  return Object.keys(params).length > 0 ? params : undefined;
}

/**
 * Middleware that creates a canonical log context and emits at request completion.
 *
 * Request ID is extracted from incoming X-Request-ID header if present,
 * otherwise a new ID is generated. This enables cross-service tracing.
 */
export function canonicalLogMiddleware(
  options: CanonicalLogMiddlewareOptions
): MiddlewareHandler {
  const extractRequestId = options.extractRequestId ?? extractFromRequest;

  return async (c, next) => {
    // Extract from header or generate new
    const requestId = extractRequestId(c.req.raw);
    const method = c.req.method;
    const path = c.req.path;

    // Create log context (params captured later after route matching)
    // Query params are sanitized to mask sensitive values
    const logCtx = createLogContext({
      requestId,
      service: options.service,
      method,
      path,
      query: extractQuery(c, options.additionalSensitiveParams),
    });

    // Store in Hono context for handlers to access
    c.set(LOG_CONTEXT_KEY, logCtx);
    c.set(REQUEST_ID_KEY, requestId);

    try {
      await next();

      // Capture response status
      logCtx.setStatus(c.res.status);

      // Capture route params and pattern (only available after route matching)
      const params = extractParams(c);
      if (params) {
        logCtx.addField('params', params);
      }

      const matchedRoute = c.req.routePath;
      if (matchedRoute) {
        logCtx.setRoute(matchedRoute);
      }
    } catch (error) {
      // Error will be handled by error handler, but record it here
      if (error instanceof Error) {
        logCtx.setError(error);
      } else {
        logCtx.setError({
          name: 'UnknownError',
          message: String(error),
        });
      }
      throw error; // Re-throw for error handler
    } finally {
      // Always emit canonical log at request completion
      logCtx.emit();
    }
  };
}

/**
 * Get the log context from Hono's context.
 * Returns undefined if middleware hasn't run.
 */
export function getLogContext(c: Context): LogContext | undefined {
  return c.get(LOG_CONTEXT_KEY);
}

/**
 * Get the request ID from Hono's context.
 * Returns undefined if middleware hasn't run.
 */
export function getRequestId(c: Context): string | undefined {
  return c.get(REQUEST_ID_KEY);
}

// Re-export for convenience
export { LOG_CONTEXT_KEY, REQUEST_ID_KEY };
