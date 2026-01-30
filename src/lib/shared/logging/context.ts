/**
 * Request context builder for canonical log lines.
 * Accumulates fields and operations throughout request lifecycle,
 * emits ONE comprehensive log entry at request completion.
 */

import { log, type LogLevel } from './logger.js';

/**
 * An operation performed during the request (for audit trail).
 */
export interface Operation {
  /** Operation type: "db.insert", "api.call", "queue.dispatch", etc. */
  op: string;
  /** Target: table name, API endpoint, queue name */
  target: string;
  /** Entity ID affected (row ID, resource ID) */
  entity_id?: string;
  /** Operation duration in ms */
  duration_ms?: number;
  /** Whether operation succeeded */
  success: boolean;
  /** Additional context */
  detail?: string;
}

/**
 * Error details for logging.
 */
export interface ErrorDetail {
  name: string;
  message: string;
  code?: string;
  stack?: string;
}

/**
 * The canonical log line structure.
 */
export interface CanonicalLogLine {
  // Tracing
  timestamp: string;
  request_id: string;
  service: string;

  // Request details
  method: string;
  path: string;
  route?: string;
  params?: Record<string, string>;
  query?: Record<string, string>;

  // Response details
  status?: number;
  duration_ms?: number;

  // Operations performed (audit trail)
  operations: Operation[];

  // Error (if any)
  error?: ErrorDetail;

  // Log level
  level: LogLevel;

  // Business context (extensible)
  [key: string]: unknown;
}

/**
 * Request-scoped log context.
 * Accumulates data throughout the request, emits canonical log at end.
 */
export class LogContext {
  private requestId: string;
  private service: string;
  private method: string;
  private path: string;
  private startTime: number;
  private route?: string;
  private params?: Record<string, string>;
  private query?: Record<string, string>;
  private operations: Operation[] = [];
  private errorDetail?: ErrorDetail;
  private fields: Record<string, unknown> = {};
  private status?: number;
  private emitted = false;

  constructor(options: {
    requestId: string;
    service: string;
    method: string;
    path: string;
    route?: string;
    params?: Record<string, string>;
    query?: Record<string, string>;
  }) {
    this.requestId = options.requestId;
    this.service = options.service;
    this.method = options.method;
    this.path = options.path;
    this.route = options.route;
    this.params = options.params;
    this.query = options.query;
    this.startTime = Date.now();
  }

  /**
   * Add a custom field to the log context.
   * Use for business context: ticker, user_id, event_type, etc.
   */
  addField(key: string, value: unknown): this {
    this.fields[key] = value;
    return this;
  }

  /**
   * Add multiple fields at once.
   */
  addFields(fields: Record<string, unknown>): this {
    Object.assign(this.fields, fields);
    return this;
  }

  /**
   * Record an operation for the audit trail.
   * Call this for significant actions: db operations, API calls, queue dispatches.
   */
  operation(
    op: string,
    target: string,
    options?: {
      entity_id?: string;
      duration_ms?: number;
      success?: boolean;
      detail?: string;
    }
  ): this {
    this.operations.push({
      op,
      target,
      entity_id: options?.entity_id,
      duration_ms: options?.duration_ms,
      success: options?.success ?? true,
      detail: options?.detail,
    });
    return this;
  }

  /**
   * Record an error. Sets the log level to error.
   */
  setError(error: ErrorDetail | Error): this {
    if (error instanceof Error) {
      this.errorDetail = {
        name: error.name,
        message: error.message,
        stack: error.stack,
        code: (error as Error & { code?: string }).code,
      };
    } else {
      this.errorDetail = error;
    }
    return this;
  }

  /**
   * Set the response status code.
   */
  setStatus(status: number): this {
    this.status = status;
    return this;
  }

  /**
   * Set the matched route pattern (e.g., "/api/events/:id").
   */
  setRoute(route: string): this {
    this.route = route;
    return this;
  }

  /**
   * Get the request ID for passing to downstream services.
   */
  getRequestId(): string {
    return this.requestId;
  }

  /**
   * Check if an error has been recorded.
   */
  hasError(): boolean {
    return !!this.errorDetail;
  }

  /**
   * Emit the canonical log line. Called once at request completion.
   * Safe to call multiple times - only emits once.
   */
  emit(): void {
    if (this.emitted) return;
    this.emitted = true;

    const duration = Date.now() - this.startTime;
    const level: LogLevel = this.errorDetail ? 'error' : 'info';

    const entry: CanonicalLogLine = {
      timestamp: new Date().toISOString(),
      level,
      request_id: this.requestId,
      service: this.service,
      method: this.method,
      path: this.path,
      route: this.route,
      params: this.params,
      query: this.query,
      status: this.status,
      duration_ms: duration,
      operations: this.operations,
      error: this.errorDetail,
      ...this.fields,
    };

    // Remove undefined values for cleaner output
    const cleanEntry = Object.fromEntries(
      Object.entries(entry).filter(([, v]) => v !== undefined)
    );

    log(level, 'request', cleanEntry);
  }
}

/**
 * Create a new log context for a request.
 */
export function createLogContext(options: {
  requestId: string;
  service: string;
  method: string;
  path: string;
  route?: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
}): LogContext {
  return new LogContext(options);
}
