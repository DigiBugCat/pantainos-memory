import type { Context, Next } from 'hono';
import { getLogContext } from '../logging/middleware.js';

export interface ApiError {
  error: string;
  message: string;
  status: number;
}

export async function errorHandler(c: Context, next: Next): Promise<Response | void> {
  try {
    await next();
    return;
  } catch (err) {
    // Extract error details from various error types
    let errorName = 'InternalError';
    let errorMessage = 'An unexpected error occurred';
    let errorStack: string | undefined;
    let errorCode: string | undefined;
    let status = 500;

    if (err instanceof Error) {
      // Standard Error object
      errorName = err.name || 'InternalError';
      errorMessage = err.message || 'An unexpected error occurred';
      errorStack = err.stack;
      // Check for code property (e.g., custom errors)
      if ('code' in err && typeof (err as { code: unknown }).code === 'string') {
        errorCode = (err as { code: string }).code;
      }
      // Check for status property on Error (e.g., HTTPException)
      if ('status' in err && typeof (err as { status: unknown }).status === 'number') {
        status = (err as { status: number }).status;
      }
    } else if (typeof err === 'object' && err !== null) {
      // Plain object with error-like properties
      const errObj = err as Record<string, unknown>;
      if (typeof errObj.name === 'string') errorName = errObj.name;
      if (typeof errObj.message === 'string') errorMessage = errObj.message;
      if (typeof errObj.status === 'number') status = errObj.status;
      if (typeof errObj.code === 'string') errorCode = errObj.code;
      if (typeof errObj.stack === 'string') errorStack = errObj.stack;
    } else if (err !== null && err !== undefined) {
      // Primitive value (string, number, etc.)
      errorMessage = String(err);
    }

    // Enrich log context with error details (will be included in canonical log)
    const logCtx = getLogContext(c);
    if (logCtx) {
      logCtx.setError({
        name: errorName,
        message: errorMessage,
        code: errorCode,
        stack: errorStack,
      });
      logCtx.setStatus(status);
    }

    const response: ApiError = {
      error: errorName,
      message: errorMessage,
      status,
    };

    return c.json(response, status as 400 | 401 | 403 | 404 | 500);
  }
}
