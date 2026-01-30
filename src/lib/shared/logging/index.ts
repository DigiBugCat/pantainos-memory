/**
 * Logging infrastructure for Cassandra workers.
 *
 * Philosophy: Canonical Log Lines (https://loggingsucks.com/)
 * - One comprehensive log entry per request
 * - Structured JSON for Cloudflare dashboard filtering
 * - Operations audit trail for tracing what happened
 * - Cross-service tracing via X-Request-ID header propagation
 * - Environment-aware log levels (debug in staging, info in production)
 */

// Core logger
export { logger, log, type LogLevel, type LogEntry } from './logger.js';

// Log level configuration
export {
  configureLogging,
  getLogConfig,
  shouldLog,
  parseLogLevel,
  resetLogConfig,
} from './config.js';

// Request ID propagation / cross-service tracing
export {
  REQUEST_ID_HEADER,
  generateRequestId,
  extractRequestId,
  withRequestId,
  tracedFetch,
  TracedFetcher,
  generateContextId,
} from './tracing.js';

// Standalone logger (for DOs, Workflows, Alarms, Queues)
export {
  createStandaloneLogger,
  logStandaloneError,
  type StandaloneLogger,
  type StandaloneLoggerOptions,
} from './standalone.js';

// Request context
export {
  LogContext,
  createLogContext,
  type Operation,
  type ErrorDetail,
  type CanonicalLogLine,
} from './context.js';

// Middleware
export {
  canonicalLogMiddleware,
  getLogContext,
  getRequestId,
  type CanonicalLogMiddlewareOptions,
  LOG_CONTEXT_KEY,
  REQUEST_ID_KEY,
} from './middleware.js';

// Handler helpers
export {
  logField,
  logFields,
  logOperation,
  timedOperation,
  getReqId,
  getLog,
  logEvent,
  logError,
} from './helpers.js';
