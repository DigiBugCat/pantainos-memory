import type { Context, Next } from 'hono';

/**
 * Default allowed origins for development.
 * Includes common localhost ports used by Vite, Wrangler, etc.
 */
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173', // Vite default
  'http://localhost:5174',
  'http://localhost:8787', // Wrangler default
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:8787',
];

/**
 * Get allowed origins from environment or use defaults.
 * Set CORS_ALLOWED_ORIGINS as a comma-separated list in your worker env.
 */
function getAllowedOrigins(c: Context): string[] {
  const envOrigins = (c.env as Record<string, unknown>)?.CORS_ALLOWED_ORIGINS;

  if (typeof envOrigins === 'string' && envOrigins.trim()) {
    return envOrigins.split(',').map((o) => o.trim()).filter(Boolean);
  }

  return DEFAULT_ALLOWED_ORIGINS;
}

/**
 * Check if the request origin is allowed.
 * Supports "*" as a wildcard to allow all origins.
 */
function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) return false;
  // Support "*" as wildcard for all origins
  if (allowedOrigins.includes('*')) return true;
  return allowedOrigins.includes(origin);
}

/**
 * CORS middleware that restricts access to known domains.
 *
 * By default, only allows localhost origins for development safety.
 * Configure CORS_ALLOWED_ORIGINS environment variable for production.
 */
export async function corsMiddleware(c: Context, next: Next): Promise<Response | void> {
  const origin = c.req.header('Origin');
  const allowedOrigins = getAllowedOrigins(c);
  const originAllowed = isOriginAllowed(origin, allowedOrigins);

  const isWildcard = allowedOrigins.includes('*');

  // Handle preflight requests
  if (c.req.method === 'OPTIONS') {
    const headers: Record<string, string> = {
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
      'Access-Control-Expose-Headers': 'Mcp-Session-Id',
      'Access-Control-Max-Age': '86400',
    };

    // Only set Allow-Origin if the origin is allowed
    if (originAllowed) {
      // For wildcard, use "*" directly (no credentials support)
      // For specific origins, echo back the origin (credentials supported)
      headers['Access-Control-Allow-Origin'] = isWildcard ? '*' : (origin || '*');
      // Only set credentials for non-wildcard
      if (!isWildcard && origin) {
        headers['Access-Control-Allow-Credentials'] = 'true';
      }
    }

    return new Response(null, {
      status: 204,
      headers,
    });
  }

  await next();

  // Add CORS headers only if origin is allowed
  if (originAllowed) {
    c.res.headers.set('Access-Control-Allow-Origin', isWildcard ? '*' : (origin || '*'));
    // Only set credentials for non-wildcard
    if (!isWildcard && origin) {
      c.res.headers.set('Access-Control-Allow-Credentials', 'true');
    }
  }
}
