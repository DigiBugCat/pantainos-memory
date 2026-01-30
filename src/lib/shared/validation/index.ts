/**
 * Request validation helpers for Hono routes.
 * Provides consistent error responses and reduces boilerplate.
 */

import type { Context } from 'hono';

/**
 * Standard validation error response format.
 */
export interface ValidationError {
  error: string;
  missing?: string[];
}

/**
 * Result of validation - either the validated values or an error response.
 */
export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; response: Response };

/**
 * Check that all required query parameters are present.
 * Returns a validation result that can be used to short-circuit the handler.
 *
 * @example
 * ```ts
 * const validation = requireParams(c, ['ticker', 'from', 'to']);
 * if (!validation.success) return validation.response;
 * const { ticker, from, to } = validation.data;
 * ```
 */
export function requireParams<T extends string>(
  c: Context,
  params: T[]
): ValidationResult<Record<T, string>> {
  const values: Record<string, string> = {};
  const missing: string[] = [];

  for (const param of params) {
    const value = c.req.query(param);
    if (!value) {
      missing.push(param);
    } else {
      values[param] = value;
    }
  }

  if (missing.length > 0) {
    return {
      success: false,
      response: c.json(
        { error: `Missing required parameter${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}` },
        400
      ),
    };
  }

  return { success: true, data: values as Record<T, string> };
}

/**
 * Get a query parameter with a default value.
 */
export function queryWithDefault(c: Context, param: string, defaultValue: string): string {
  return c.req.query(param) || defaultValue;
}

/**
 * Get a query parameter as an integer with a required default.
 * Always returns a number since a default is required.
 */
export function queryInt(c: Context, param: string, defaultValue: number): number;

/**
 * Get a query parameter as an integer without a default.
 * Returns undefined if the param is not present.
 */
export function queryInt(c: Context, param: string): number | undefined;

/**
 * Get a query parameter as an integer with optional default.
 * Returns undefined if the param is not present and no default is provided.
 * Throws an error if the value is not a valid integer.
 */
export function queryInt(
  c: Context,
  param: string,
  defaultValue?: number
): number | undefined {
  const value = c.req.query(param);
  if (!value) return defaultValue;

  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Invalid integer value for parameter '${param}': ${value}`);
  }
  return parsed;
}
