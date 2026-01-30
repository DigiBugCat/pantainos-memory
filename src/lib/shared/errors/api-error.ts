/**
 * Standardized API error responses
 *
 * Provides consistent error format across all workers:
 * { error: string, code?: string, details?: unknown }
 */

import type { Context } from 'hono';

// Common error codes for programmatic handling
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ApiErrorResponse {
  error: string;
  code?: ErrorCode;
  details?: unknown;
}

/**
 * Create a standardized error response
 */
export function apiError(
  c: Context,
  status: number,
  message: string,
  options?: { code?: ErrorCode; details?: unknown }
): Response {
  const body: ApiErrorResponse = { error: message };
  if (options?.code) body.code = options.code;
  if (options?.details) body.details = options.details;
  return c.json(body, status as Parameters<typeof c.json>[1]);
}

/**
 * 400 Validation Error - Missing or invalid parameters
 */
export function validationError(
  c: Context,
  message: string,
  details?: unknown
): Response {
  return apiError(c, 400, message, { code: ErrorCode.VALIDATION_ERROR, details });
}

/**
 * 404 Not Found - Resource doesn't exist
 */
export function notFound(
  c: Context,
  resource = 'Resource'
): Response {
  return apiError(c, 404, `${resource} not found`, { code: ErrorCode.NOT_FOUND });
}
