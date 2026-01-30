/**
 * Cloudflare Access JWT verification
 */

import { createStandaloneLogger, generateContextId } from '../lib/shared/logging/index.js';
import type { CFAccessJWT, UserInfo, OAuthEnv } from './types.js';

// Create logger for access handler operations
const createAccessLogger = (operation: string) =>
  createStandaloneLogger({
    component: 'CFAccessHandler',
    requestId: generateContextId('access'),
    baseContext: { operation },
  });

// CF Access JWKS endpoint
const CF_ACCESS_CERTS_URL = 'https://{team}.cloudflareaccess.com/cdn-cgi/access/certs';

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

// Verify and decode CF Access JWT
export async function verifyCFAccessJWT(
  jwt: string,
  env: OAuthEnv
): Promise<CFAccessJWT | null> {
  const log = createAccessLogger('verify_jwt');
  const team = env.CF_ACCESS_TEAM;
  if (!team) {
    log.error('missing_config', { field: 'CF_ACCESS_TEAM' });
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
      log.warn('key_not_found', { kid: header.kid });
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

    // Verify signature
    const signatureBytes = Uint8Array.from(
      atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')),
      (c) => c.charCodeAt(0)
    );
    const dataBytes = new TextEncoder().encode(parts[0] + '.' + parts[1]);

    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      signatureBytes,
      dataBytes
    );

    if (!valid) {
      log.warn('signature_invalid');
      return null;
    }

    // Verify audience (skip if CF_ACCESS_AUD not configured)
    if (env.CF_ACCESS_AUD && (!payload.aud || !payload.aud.includes(env.CF_ACCESS_AUD))) {
      log.warn('invalid_audience', { expected: env.CF_ACCESS_AUD, got: payload.aud });
      return null;
    }

    // Verify expiration
    if (payload.exp && payload.exp < Date.now() / 1000) {
      log.warn('jwt_expired', { exp: payload.exp });
      return null;
    }

    return payload as CFAccessJWT;
  } catch (error) {
    log.error('verification_failed', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

// Extract user info from CF Access JWT
export function extractUserInfo(jwt: CFAccessJWT): UserInfo {
  return {
    id: jwt.sub,
    email: jwt.email,
    name: jwt.email.split('@')[0],
  };
}

// Get CF Access JWT from request (cookie or header)
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
