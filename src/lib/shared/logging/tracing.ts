/**
 * Request ID propagation utilities for cross-service tracing.
 *
 * Enables tracing requests across service boundaries by propagating
 * request IDs through HTTP headers. This allows correlating logs
 * from multiple services handling the same user request.
 */

/** Standard header name for request ID propagation */
export const REQUEST_ID_HEADER = 'X-Request-ID';

/**
 * Generate a short request ID (8 chars from UUID).
 * Used when no incoming request ID is present.
 */
export function generateRequestId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * Extract request ID from incoming request headers.
 * Returns existing ID if present, otherwise generates a new one.
 */
export function extractRequestId(request: Request): string {
  const existing = request.headers.get(REQUEST_ID_HEADER);
  if (existing && existing.length > 0) {
    // Sanitize: only allow alphanumeric and hyphens, max 64 chars
    const sanitized = existing.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
    return sanitized || generateRequestId();
  }
  return generateRequestId();
}

/**
 * Create headers with request ID included.
 * Merges with existing headers if provided.
 */
export function withRequestId(
  requestId: string,
  existingHeaders?: HeadersInit
): Headers {
  const headers = new Headers(existingHeaders);
  headers.set(REQUEST_ID_HEADER, requestId);
  return headers;
}

/**
 * Create a traced version of a Fetcher (service binding).
 * Automatically adds request ID to all outgoing requests.
 *
 * This is useful for propagating tracing context through service bindings.
 */
export function tracedFetch(fetcher: Fetcher, requestId: string): TracedFetcher {
  return new TracedFetcher(fetcher, requestId);
}

/**
 * A wrapped Fetcher that automatically adds request ID to all requests.
 */
export class TracedFetcher {
  constructor(
    private readonly fetcher: Fetcher,
    private readonly requestId: string
  ) {}

  /**
   * Fetch with automatic request ID propagation.
   */
  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    // Handle Request objects
    if (input instanceof Request) {
      const newHeaders = withRequestId(this.requestId, input.headers);
      // Create new request with traced headers
      // Clone body carefully to avoid duplex issues
      const requestInit: RequestInit = {
        method: input.method,
        headers: newHeaders,
        redirect: input.redirect,
      };

      // Only include body for methods that support it
      // and handle streaming bodies with duplex option
      if (input.body !== null && !['GET', 'HEAD'].includes(input.method)) {
        requestInit.body = input.body;
        // Required for streaming bodies in modern fetch
        (requestInit as RequestInit & { duplex?: string }).duplex = 'half';
      }

      const newRequest = new Request(input.url, requestInit);
      return this.fetcher.fetch(newRequest);
    }

    // Handle URL or string
    const headers = withRequestId(this.requestId, init?.headers);
    return this.fetcher.fetch(input, {
      ...init,
      headers,
    });
  }
}

/**
 * Generate a unique ID for non-request contexts (alarms, cron, queues).
 * Prefixes with context type for easy identification in logs.
 */
export function generateContextId(contextType: string): string {
  return `${contextType}-${generateRequestId()}`;
}
