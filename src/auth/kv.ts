/**
 * KV storage helpers for OAuth data
 */

const PREFIX = {
  CLIENT: 'oauth:client:',
  AUTH_CODE: 'oauth:code:',
  ACCESS_TOKEN: 'oauth:access:',
  REFRESH_TOKEN: 'oauth:refresh:',
  AUTH_STATE: 'oauth:state:',
} as const;

// TTLs in seconds
const TTL = {
  AUTH_CODE: 600,        // 10 minutes
  ACCESS_TOKEN: 3600,    // 1 hour
  REFRESH_TOKEN: 604800, // 7 days
  AUTH_STATE: 600,       // 10 minutes
} as const;

export async function storeClient(kv: KVNamespace, clientId: string, client: unknown): Promise<void> {
  await kv.put(PREFIX.CLIENT + clientId, JSON.stringify(client));
}

export async function getClient(kv: KVNamespace, clientId: string): Promise<unknown | null> {
  const data = await kv.get(PREFIX.CLIENT + clientId);
  return data ? JSON.parse(data) : null;
}

export async function storeAuthCode(
  kv: KVNamespace,
  code: string,
  data: unknown
): Promise<void> {
  await kv.put(PREFIX.AUTH_CODE + code, JSON.stringify(data), {
    expirationTtl: TTL.AUTH_CODE,
  });
}

export async function getAuthCode(kv: KVNamespace, code: string): Promise<unknown | null> {
  const data = await kv.get(PREFIX.AUTH_CODE + code);
  if (!data) return null;
  // Delete after retrieval (single use)
  await kv.delete(PREFIX.AUTH_CODE + code);
  return JSON.parse(data);
}

export async function storeAccessToken(
  kv: KVNamespace,
  token: string,
  data: unknown
): Promise<void> {
  await kv.put(PREFIX.ACCESS_TOKEN + token, JSON.stringify(data), {
    expirationTtl: TTL.ACCESS_TOKEN,
  });
}

export async function getAccessToken(kv: KVNamespace, token: string): Promise<unknown | null> {
  const data = await kv.get(PREFIX.ACCESS_TOKEN + token);
  return data ? JSON.parse(data) : null;
}

export async function storeRefreshToken(
  kv: KVNamespace,
  token: string,
  data: unknown
): Promise<void> {
  await kv.put(PREFIX.REFRESH_TOKEN + token, JSON.stringify(data), {
    expirationTtl: TTL.REFRESH_TOKEN,
  });
}

export async function getRefreshToken(kv: KVNamespace, token: string): Promise<unknown | null> {
  const data = await kv.get(PREFIX.REFRESH_TOKEN + token);
  return data ? JSON.parse(data) : null;
}

export async function deleteRefreshToken(kv: KVNamespace, token: string): Promise<void> {
  await kv.delete(PREFIX.REFRESH_TOKEN + token);
}

export async function storeAuthState(
  kv: KVNamespace,
  state: string,
  data: unknown
): Promise<void> {
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
