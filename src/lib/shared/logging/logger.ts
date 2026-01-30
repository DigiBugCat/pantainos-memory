/**
 * Core structured JSON logger for Cloudflare Workers.
 * Outputs machine-parseable JSON for dashboard filtering.
 *
 * Respects log level configuration - debug logs are filtered
 * in production to reduce volume and costs.
 */

import { shouldLog, getLogConfig, type LogLevel as ConfigLogLevel } from './config.js';

// Re-export LogLevel from config for backwards compatibility
export type LogLevel = ConfigLogLevel;

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  environment?: string;
  service?: string;
  [key: string]: unknown;
}

/**
 * Log a structured JSON entry to console.
 * Uses console.error for error level, console.log for others.
 *
 * Respects log level filtering - logs below the configured
 * threshold are not emitted.
 */
export function log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  // Check if this level should be logged
  if (!shouldLog(level)) return;

  const config = getLogConfig();
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    environment: config.environment,
    service: config.service,
    ...context,
  };

  // Remove undefined values for cleaner output
  const cleanEntry = Object.fromEntries(
    Object.entries(entry).filter(([, v]) => v !== undefined)
  );

  // JSON format for Cloudflare dashboard parsing
  const json = JSON.stringify(cleanEntry);

  if (level === 'error') {
    console.error(json);
  } else {
    console.log(json);
  }
}

/**
 * Simple logger for standalone logging (outside request context).
 * For request-scoped logging, use LogContext from context.ts instead.
 *
 * Note: For Durable Objects and Workflows, prefer createStandaloneLogger
 * from standalone.ts which includes component context.
 */
export const logger = {
  debug: (msg: string, ctx?: Record<string, unknown>) => log('debug', msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => log('info', msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => log('warn', msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => log('error', msg, ctx),
};
