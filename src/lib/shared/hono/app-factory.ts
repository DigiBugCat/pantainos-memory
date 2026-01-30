/**
 * Hono app factory for creating standardized worker apps.
 * Provides consistent middleware setup and health check endpoints.
 *
 * Includes canonical logging middleware for structured JSON logs
 * with request ID correlation and operations audit trail.
 *
 * Automatically configures logging from environment variables:
 * - LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error' (default: 'info')
 * - ENVIRONMENT: 'production' | 'staging' | 'development' (default: 'production')
 */

import { Hono } from 'hono';
import { errorHandler } from '../middleware/error-handler.js';
import { corsMiddleware } from '../middleware/cors.js';
import { canonicalLogMiddleware } from '../logging/middleware.js';
import { configureLogging, parseLogLevel } from '../logging/config.js';

export interface WorkerAppOptions {
  /**
   * Service name for health check and logging.
   */
  serviceName: string;
}

/**
 * Standard environment variables for logging configuration.
 * Workers can extend this interface with their own bindings.
 */
export interface LoggingEnv {
  /** Log level: 'debug' | 'info' | 'warn' | 'error' */
  LOG_LEVEL?: string;
  /** Environment: 'production' | 'staging' | 'development' */
  ENVIRONMENT?: string;
}

/**
 * Create a new Hono app with standard middleware and health check.
 *
 * Automatically includes:
 * - Log configuration middleware (initializes from env)
 * - Canonical logging middleware (structured JSON, request ID, audit trail)
 * - Error handler (catches unhandled exceptions)
 * - CORS middleware
 * - GET /health endpoint
 *
 * Environment variables:
 * - LOG_LEVEL: Controls which logs are emitted (debug, info, warn, error)
 * - ENVIRONMENT: Included in log entries for filtering
 */
export function createWorkerApp<
  TEnv extends LoggingEnv,
  TVariables extends object = object,
>(
  options: WorkerAppOptions
): Hono<{ Bindings: TEnv; Variables: TVariables }> {
  const app = new Hono<{ Bindings: TEnv; Variables: TVariables }>();

  // Global middleware
  // Order matters: config first (sets log level), logging second, then error handler, then CORS

  // Initialize logging configuration from environment
  app.use('*', async (c, next) => {
    configureLogging({
      level: parseLogLevel(c.env?.LOG_LEVEL),
      service: options.serviceName,
      environment: c.env?.ENVIRONMENT || 'production',
    });
    await next();
  });

  app.use('*', canonicalLogMiddleware({ service: options.serviceName }));
  app.use('*', errorHandler);
  app.use('*', corsMiddleware);

  // Health check endpoint
  app.get('/health', (c) => c.json({ status: 'ok', service: options.serviceName }));

  return app;
}
