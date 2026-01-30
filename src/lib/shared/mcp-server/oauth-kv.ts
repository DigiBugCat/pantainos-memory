/**
 * KV storage helpers for OAuth data
 *
 * Provides functions to store and retrieve OAuth-related data
 * (clients, auth codes, tokens) from Cloudflare KV.
 */

import type { OAuthClient, AuthCodeData, AccessTokenData, RefreshTokenData } from './types.js';

const PREFIX = {
  CLIENT: 'oauth:client:',
  AUTH_CODE: 'oauth:code:',
  ACCESS_TOKEN: 'oauth:access:',
  REFRESH_TOKEN: 'oauth:refresh:',
  AUTH_STATE: 'oauth:state:',
} as const;

// TTLs in seconds
const TTL = {
  AUTH_CODE: 600, // 10 minutes
  ACCESS_TOKEN: 3600, // 1 hour
  REFRESH_TOKEN: 604800, // 7 days
  AUTH_STATE: 600, // 10 minutes
} as const;

// =============================================================================
// Client Storage
// =============================================================================

export async function storeClient(kv: KVNamespace, clientId: string, client: OAuthClient): Promise<void> {
  await kv.put(PREFIX.CLIENT + clientId, JSON.stringify(client));
}

export async function getClient(kv: KVNamespace, clientId: string): Promise<OAuthClient | null> {
  const data = await kv.get(PREFIX.CLIENT + clientId);
  return data ? (JSON.parse(data) as OAuthClient) : null;
}

// =============================================================================
// Authorization Code Storage
// =============================================================================

export async function storeAuthCode(kv: KVNamespace, code: string, data: AuthCodeData): Promise<void> {
  await kv.put(PREFIX.AUTH_CODE + code, JSON.stringify(data), {
    expirationTtl: TTL.AUTH_CODE,
  });
}

export async function getAuthCode(kv: KVNamespace, code: string): Promise<AuthCodeData | null> {
  const data = await kv.get(PREFIX.AUTH_CODE + code);
  if (!data) return null;
  // Delete after retrieval (single use)
  await kv.delete(PREFIX.AUTH_CODE + code);
  return JSON.parse(data) as AuthCodeData;
}

// =============================================================================
// Access Token Storage
// =============================================================================

export async function storeAccessToken(kv: KVNamespace, token: string, data: AccessTokenData): Promise<void> {
  await kv.put(PREFIX.ACCESS_TOKEN + token, JSON.stringify(data), {
    expirationTtl: TTL.ACCESS_TOKEN,
  });
}

export async function getAccessToken(kv: KVNamespace, token: string): Promise<AccessTokenData | null> {
  const data = await kv.get(PREFIX.ACCESS_TOKEN + token);
  return data ? (JSON.parse(data) as AccessTokenData) : null;
}

// =============================================================================
// Refresh Token Storage
// =============================================================================

export async function storeRefreshToken(kv: KVNamespace, token: string, data: RefreshTokenData): Promise<void> {
  await kv.put(PREFIX.REFRESH_TOKEN + token, JSON.stringify(data), {
    expirationTtl: TTL.REFRESH_TOKEN,
  });
}

export async function getRefreshToken(kv: KVNamespace, token: string): Promise<RefreshTokenData | null> {
  const data = await kv.get(PREFIX.REFRESH_TOKEN + token);
  return data ? (JSON.parse(data) as RefreshTokenData) : null;
}

export async function deleteRefreshToken(kv: KVNamespace, token: string): Promise<void> {
  await kv.delete(PREFIX.REFRESH_TOKEN + token);
}

// =============================================================================
// Auth State Storage (for OAuth flow state preservation)
// =============================================================================

export async function storeAuthState(kv: KVNamespace, state: string, data: unknown): Promise<void> {
  await kv.put(PREFIX.AUTH_STATE + state, JSON.stringify(data), {
    expirationTtl: TTL.AUTH_STATE,
  });
}

export async function getAuthState(kv: KVNamespace, state: string): Promise<unknown | null> {
  const data = await kv.get(PREFIX.AUTH_STATE + state);
  if (!data) return null;
  // Delete after retrieval (single use)
  await kv.delete(PREFIX.AUTH_STATE + state);
  return JSON.parse(data);
}
