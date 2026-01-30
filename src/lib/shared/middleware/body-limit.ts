/**
 * Request body size limiting middleware.
 *
 * Prevents DoS attacks and resource exhaustion by limiting the size
 * of request bodies. Particularly important for endpoints that process
 * expensive operations like embedding generation.
 */

import type { Context, Next, MiddlewareHandler } from 'hono';

/**
 * Options for body size limiting.
 */
export interface BodyLimitOptions {
  /**
   * Maximum allowed body size in bytes.
   * Default: 1MB (1048576 bytes)
   */
  maxSize?: number;

  /**
   * Custom handler for oversized requests.
   */
  onError?: (c: Context, maxSize: number, contentLength: number | null) => Response | Promise<Response>;
}

/**
 * Default error handler for oversized requests.
 */
function defaultErrorHandler(c: Context, maxSize: number, contentLength: number | null): Response {
  return c.json(
    {
      error: 'PayloadTooLarge',
      message: `Request body exceeds maximum allowed size of ${maxSize} bytes`,
      maxSize,
      received: contentLength,
    },
    413
  );
}

/**
 * Middleware that limits request body size.
 */
export function bodyLimit(options: BodyLimitOptions = {}): MiddlewareHandler {
  const {
    maxSize = 1024 * 1024, // 1MB default
    onError = defaultErrorHandler,
  } = options;

  return async (c: Context, next: Next): Promise<Response | void> => {
    // Only check for methods that typically have a body
    const method = c.req.method;
    if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') {
      return next();
    }

    // Check Content-Length header
    const contentLengthHeader = c.req.header('Content-Length');
    const contentLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : null;

    if (contentLength !== null && contentLength > maxSize) {
      return onError(c, maxSize, contentLength);
    }

    return next();
  };
}

/**
 * Field length validation for request bodies.
 */
export interface FieldLimitOptions {
  /**
   * Field name to limit (supports dot notation for nested fields).
   */
  field: string;

  /**
   * Maximum allowed length in characters.
   */
  maxLength: number;

  /**
   * Custom error message.
   */
  message?: string;
}

/**
 * Middleware that validates field lengths in JSON bodies.
 */
export function fieldLimits(limits: FieldLimitOptions[]): MiddlewareHandler {
  return async (c: Context, next: Next): Promise<Response | void> => {
    // Only check for methods that typically have a JSON body
    const method = c.req.method;
    if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') {
      return next();
    }

    const contentType = c.req.header('Content-Type');
    if (!contentType?.includes('application/json')) {
      return next();
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      // Let the handler deal with invalid JSON
      return next();
    }

    // Validate each field limit
    for (const limit of limits) {
      const value = getNestedValue(body, limit.field);

      if (value === undefined || value === null) {
        continue;
      }

      const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
      if (stringValue.length > limit.maxLength) {
        return c.json(
          {
            error: 'ValidationError',
            message: limit.message || `Field '${limit.field}' exceeds maximum length of ${limit.maxLength} characters`,
            field: limit.field,
            maxLength: limit.maxLength,
            actualLength: stringValue.length,
          },
          400
        );
      }
    }

    // Store parsed body for handler to avoid re-parsing
    c.set('parsedBody', body);

    return next();
  };
}

/**
 * Get a nested value from an object using dot notation.
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce((current: unknown, key) => {
    if (current && typeof current === 'object' && key in (current as Record<string, unknown>)) {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/**
 * Preset body limits for common use cases.
 */
export const bodyLimitPresets = {
  /**
   * Standard API: 1MB
   */
  standard: () => bodyLimit({ maxSize: 1024 * 1024 }),

  /**
   * Small payloads: 100KB (for simple JSON endpoints)
   */
  small: () => bodyLimit({ maxSize: 100 * 1024 }),

  /**
   * Large payloads: 10MB (for file uploads)
   */
  large: () => bodyLimit({ maxSize: 10 * 1024 * 1024 }),

  /**
   * Memory/embedding endpoints: 50KB (prevents expensive operations)
   */
  memory: () => bodyLimit({ maxSize: 50 * 1024 }),
};

/**
 * Common field limits for memory operations.
 */
export const memoryFieldLimits = fieldLimits([
  { field: 'content', maxLength: 10000, message: 'Content exceeds maximum length of 10,000 characters' },
  { field: 'source', maxLength: 100, message: 'Source exceeds maximum length of 100 characters' },
  { field: 'tags', maxLength: 500, message: 'Tags array exceeds maximum serialized length of 500 characters' },
  { field: 'invalidates_if', maxLength: 1000, message: 'invalidates_if exceeds maximum length of 1,000 characters' },
  { field: 'confirms_if', maxLength: 1000, message: 'confirms_if exceeds maximum length of 1,000 characters' },
]);
