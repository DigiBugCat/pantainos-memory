/**
 * Log level configuration for Cassandra workers.
 *
 * Controls which log levels are emitted based on environment configuration.
 * Debug logs are filtered at emit time in production to reduce volume/costs.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

interface LogConfig {
  /** Minimum log level to emit (logs below this are filtered) */
  level: LogLevel;
  /** Service name for log context */
  service: string;
  /** Environment (production, staging, development) */
  environment: string;
}

// Global configuration (per-isolate)
let globalConfig: LogConfig = {
  level: 'info',
  service: 'unknown',
  environment: 'production',
};

/**
 * Configure logging for the current context.
 * Call this at the start of request handling or in worker init.
 */
export function configureLogging(config: Partial<LogConfig>): void {
  globalConfig = {
    ...globalConfig,
    ...config,
  };
}

/**
 * Get current log configuration.
 */
export function getLogConfig(): Readonly<LogConfig> {
  return globalConfig;
}

/**
 * Check if a log level should be emitted based on current configuration.
 * Compares the given level against the configured minimum level.
 */
export function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[globalConfig.level];
}

/**
 * Parse a log level from environment variable value.
 * Returns 'info' for invalid/missing values (safe default).
 */
export function parseLogLevel(value: string | undefined): LogLevel {
  if (!value) return 'info';

  const normalized = value.toLowerCase().trim();
  if (normalized in LOG_LEVEL_PRIORITY) {
    return normalized as LogLevel;
  }

  return 'info';
}

/**
 * Reset logging configuration to defaults.
 * Useful for testing.
 */
export function resetLogConfig(): void {
  globalConfig = {
    level: 'info',
    service: 'unknown',
    environment: 'production',
  };
}
