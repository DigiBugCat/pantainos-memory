/**
 * Cloudflare Access JWT verification
 *
 * Handles verification of CF Access JWTs for OAuth authentication.
 * This allows MCP workers to verify user identity via CF Access
 * without requiring CF Access to protect the domain directly.
 */

import type { CFAccessJWT, UserInfo, OAuthEnv } from './types.js';

// CF Access JWKS endpoint
const CF_ACCESS_CERTS_URL = 'https://{team}.cloudflareaccess.com/cdn-cgi/access/certs';

/**
 * Convert base64url to base64 with proper padding.
 * JWTs use base64url encoding (RFC 4648) but atob() requires standard base64.
 */
function base64UrlToBase64(base64url: string): string {
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  // Add padding if needed
  const pad = base64.length % 4;
  if (pad) {
    base64 += '='.repeat(4 - pad);
  }
  return base64;
}

interface JWK {
  kid: string;
  kty: string;
  alg: string;
  n: string;
  e: string;
}

interface JWKS {
  keys: JWK[];
  public_cert: { kid: string; cert: string };
  public_certs: { kid: string; cert: string }[];
}

// Fetch JWKS from CF Access
async function getJWKS(team: string): Promise<JWKS> {
  const url = CF_ACCESS_CERTS_URL.replace('{team}', team);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch JWKS: ${response.status}`);
  }
  return response.json();
}

/**
 * Verify and decode a Cloudflare Access JWT.
 *
 * @param jwt - The JWT string to verify
 * @param env - Environment containing CF_ACCESS_TEAM and optional CF_ACCESS_AUD
 * @returns The decoded JWT claims if valid, null otherwise
 */
export async function verifyCFAccessJWT(jwt: string, env: OAuthEnv): Promise<CFAccessJWT | null> {
  const team = env.CF_ACCESS_TEAM;
  if (!team) {
    console.error('[ACCESS] CF_ACCESS_TEAM not configured');
    return null;
  }

  try {
    const jwks = await getJWKS(team);

    // Parse JWT
    const parts = jwt.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const header = JSON.parse(atob(parts[0]));
    const payload = JSON.parse(atob(parts[1]));

    // Find the matching key
    const key = jwks.keys.find((k) => k.kid === header.kid);
    if (!key) {
      console.error('[ACCESS] No matching key found in JWKS');
      return null;
    }

    // Import the public key
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      {
        kty: key.kty,
        n: key.n,
        e: key.e,
        alg: key.alg,
      },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );

    // Verify signature (use base64UrlToBase64 for proper padding)
    const signatureBytes = Uint8Array.from(
      atob(base64UrlToBase64(parts[2])),
      (c) => c.charCodeAt(0)
    );
    const dataBytes = new TextEncoder().encode(parts[0] + '.' + parts[1]);

    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, signatureBytes, dataBytes);

    if (!valid) {
      console.error('[ACCESS] JWT signature verification failed');
      return null;
    }

    // Verify audience (skip if CF_ACCESS_AUD not configured)
    if (env.CF_ACCESS_AUD && (!payload.aud || !payload.aud.includes(env.CF_ACCESS_AUD))) {
      console.error('[ACCESS] Invalid audience in JWT');
      return null;
    }

    // Verify expiration
    if (payload.exp && payload.exp < Date.now() / 1000) {
      console.error('[ACCESS] JWT has expired');
      return null;
    }

    return payload as CFAccessJWT;
  } catch (error) {
    console.error('[ACCESS] JWT verification error:', error);
    return null;
  }
}

/**
 * Extract user info from a verified CF Access JWT.
 */
export function extractUserInfo(jwt: CFAccessJWT): UserInfo {
  return {
    id: jwt.sub,
    email: jwt.email,
    name: jwt.email.split('@')[0],
  };
}

/**
 * Get CF Access JWT from request (cookie or header).
 *
 * Checks both the CF_Authorization cookie (browser flow)
 * and the Cf-Access-Jwt-Assertion header (API flow).
 */
export function getCFAccessJWT(request: Request): string | null {
  // Check cookie first (browser flow)
  const cookies = request.headers.get('Cookie') || '';
  const cfAccessMatch = cookies.match(/CF_Authorization=([^;]+)/);
  if (cfAccessMatch) {
    return cfAccessMatch[1];
  }

  // Check header (API flow)
  const authHeader = request.headers.get('Cf-Access-Jwt-Assertion');
  if (authHeader) {
    return authHeader;
  }

  return null;
}

/**
 * Construct the Cloudflare Access login URL.
 *
 * This URL redirects users to CF Access for authentication,
 * then back to the specified return path.
 */
export function getCFAccessLoginUrl(team: string, hostname: string, returnPath: string): string {
  const redirectUrl = encodeURIComponent(returnPath);
  return `https://${team}.cloudflareaccess.com/cdn-cgi/access/login/${hostname}?redirect_url=${redirectUrl}`;
}
