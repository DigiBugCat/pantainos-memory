/**
 * OAuth Provider for MCP authentication with Cloudflare Access
 *
 * Implements the OAuth 2.0 authorization code flow with PKCE support,
 * backed by Cloudflare Access for identity verification.
 *
 * Endpoints:
 * - GET /authorize: Start OAuth flow, redirect to CF Access if not authenticated
 * - POST /token: Exchange code for tokens or refresh tokens
 * - POST /register: Dynamic Client Registration (RFC 7591)
 */

import type { OAuthEnv, UserInfo, DCRRequest, OAuthClient } from './types.js';
import { verifyCFAccessJWT, extractUserInfo, getCFAccessJWT, getCFAccessLoginUrl } from './access-handler.js';
import {
  storeClient,
  getClient,
  storeAuthCode,
  getAuthCode,
  storeAccessToken,
  getAccessToken,
  storeRefreshToken,
  getRefreshToken,
  deleteRefreshToken,
} from './oauth-kv.js';

// Generate cryptographically secure random string
function generateToken(length: number = 32): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// CORS headers for OAuth responses (cross-origin requests from Claude.ai etc.)
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// JSON error response helper
function jsonError(error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status: 400,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

/**
 * Validate redirect_uri against client's registered URIs (RFC 6749).
 *
 * Security requirements:
 * - No fragments allowed in redirect_uri
 * - Must exactly match one of the client's registered URIs
 */
function validateRedirectUri(redirectUri: string, client: OAuthClient): boolean {
  // RFC 6749: No fragments allowed in redirect_uri
  if (redirectUri.includes('#')) {
    return false;
  }

  // Exact match against registered URIs
  return client.redirect_uris.includes(redirectUri);
}

// =============================================================================
// Authorization Handler
// =============================================================================

/**
 * Handle OAuth authorization requests.
 *
 * If the user has a valid CF Access JWT, issues an authorization code.
 * Otherwise, redirects to CF Access for authentication.
 */
export async function authorizeHandler(request: Request, env: OAuthEnv): Promise<Response> {
  const url = new URL(request.url);

  // Extract OAuth params
  const clientId = url.searchParams.get('client_id');
  const redirectUri = url.searchParams.get('redirect_uri');
  const responseType = url.searchParams.get('response_type');
  const scope = url.searchParams.get('scope') || '';
  const state = url.searchParams.get('state') || '';
  const codeChallenge = url.searchParams.get('code_challenge');
  const codeChallengeMethod = url.searchParams.get('code_challenge_method');

  console.log(`[AUTH] Authorize request - client_id: ${clientId}, redirect_uri: ${redirectUri}`);

  // Validate required params
  if (!clientId || !redirectUri || responseType !== 'code') {
    console.log(`[AUTH] Invalid params`);
    return new Response('Invalid authorization request', { status: 400 });
  }

  // Verify client exists
  const client = await getClient(env.OAUTH_KV, clientId);
  if (!client) {
    console.log(`[AUTH] Client not found: ${clientId}`);
    return new Response('Unknown client', { status: 400 });
  }

  // Validate redirect_uri against client's registered URIs (RFC 6749)
  if (!validateRedirectUri(redirectUri, client)) {
    console.log(`[AUTH] Invalid redirect_uri: ${redirectUri} not in client's registered URIs`);
    return new Response('Invalid redirect_uri', { status: 400 });
  }

  // Check for CF Access JWT
  const accessJWT = getCFAccessJWT(request);

  if (accessJWT) {
    console.log(`[AUTH] Verifying CF Access JWT...`);
    const claims = await verifyCFAccessJWT(accessJWT, env);
    if (claims) {
      console.log(`[AUTH] JWT verified, user: ${claims.email}`);
      const userInfo = extractUserInfo(claims);
      return issueAuthorizationCode(
        env,
        clientId,
        redirectUri,
        scope,
        state,
        codeChallenge,
        codeChallengeMethod,
        userInfo
      );
    }
  }

  // Not authenticated - redirect to CF Access login directly
  const cfAccessTeam = env.CF_ACCESS_TEAM;
  if (!cfAccessTeam) {
    console.log(`[AUTH] No CF_ACCESS_TEAM configured, cannot redirect to login`);
    return new Response('Authentication not configured', { status: 500 });
  }

  // Construct the CF Access login URL
  const currentUrl = new URL(request.url);
  const hostname = currentUrl.hostname;
  const returnPath = currentUrl.pathname + currentUrl.search;

  const cfAccessLoginUrl = getCFAccessLoginUrl(cfAccessTeam, hostname, returnPath);

  console.log(`[AUTH] No valid JWT, redirecting to CF Access login: ${cfAccessLoginUrl}`);
  return Response.redirect(cfAccessLoginUrl, 302);
}

// Issue authorization code after successful authentication
async function issueAuthorizationCode(
  env: OAuthEnv,
  clientId: string,
  redirectUri: string,
  scope: string,
  state: string,
  codeChallenge: string | null,
  codeChallengeMethod: string | null,
  userInfo: UserInfo
): Promise<Response> {
  const code = generateToken(32);
  console.log(`[AUTH] Issuing auth code for user: ${userInfo.email}`);

  await storeAuthCode(env.OAUTH_KV, code, {
    clientId,
    redirectUri,
    scope,
    codeChallenge,
    codeChallengeMethod,
    userId: userInfo.id,
    email: userInfo.email,
    issuedAt: Date.now(),
  });

  const redirectUrl = new URL(redirectUri);
  redirectUrl.searchParams.set('code', code);
  if (state) {
    redirectUrl.searchParams.set('state', state);
  }

  console.log(`[AUTH] Redirecting to callback`);
  return Response.redirect(redirectUrl.toString(), 302);
}

// =============================================================================
// Token Handler
// =============================================================================

/**
 * Handle OAuth token requests.
 *
 * Supports:
 * - authorization_code: Exchange code for tokens
 * - refresh_token: Get new tokens with refresh token
 */
export async function tokenHandler(request: Request, env: OAuthEnv): Promise<Response> {
  const contentType = request.headers.get('Content-Type') || '';

  let params: URLSearchParams;

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const body = await request.text();
    params = new URLSearchParams(body);
  } else if (contentType.includes('application/json')) {
    const body = (await request.json()) as Record<string, string>;
    params = new URLSearchParams(body);
  } else {
    return new Response('Unsupported content type', { status: 400, headers: CORS_HEADERS });
  }

  const grantType = params.get('grant_type');
  const clientId = params.get('client_id');

  if (!clientId) {
    return jsonError('invalid_request', 'client_id required');
  }

  // Verify client
  const client = await getClient(env.OAUTH_KV, clientId);
  if (!client) {
    return jsonError('invalid_client', 'Unknown client');
  }

  if (grantType === 'authorization_code') {
    return handleAuthCodeGrant(params, env, clientId);
  } else if (grantType === 'refresh_token') {
    return handleRefreshTokenGrant(params, env, clientId);
  } else {
    return jsonError('unsupported_grant_type', 'Grant type not supported');
  }
}

async function handleAuthCodeGrant(params: URLSearchParams, env: OAuthEnv, clientId: string): Promise<Response> {
  const code = params.get('code');
  const redirectUri = params.get('redirect_uri');
  const codeVerifier = params.get('code_verifier');

  if (!code || !redirectUri) {
    return jsonError('invalid_request', 'code and redirect_uri required');
  }

  // Get and validate auth code
  const authCode = await getAuthCode(env.OAUTH_KV, code);

  if (!authCode) {
    return jsonError('invalid_grant', 'Invalid or expired authorization code');
  }

  if (authCode.clientId !== clientId) {
    return jsonError('invalid_grant', 'Code was not issued to this client');
  }

  if (authCode.redirectUri !== redirectUri) {
    return jsonError('invalid_grant', 'redirect_uri mismatch');
  }

  // Verify PKCE if code challenge was provided
  if (authCode.codeChallenge) {
    if (!codeVerifier) {
      return jsonError('invalid_request', 'code_verifier required');
    }

    const verified = await verifyPKCE(codeVerifier, authCode.codeChallenge, authCode.codeChallengeMethod);

    if (!verified) {
      return jsonError('invalid_grant', 'PKCE verification failed');
    }
  }

  // Issue tokens
  return issueTokens(env, clientId, authCode.userId, authCode.email, authCode.scope);
}

async function handleRefreshTokenGrant(params: URLSearchParams, env: OAuthEnv, clientId: string): Promise<Response> {
  const refreshToken = params.get('refresh_token');

  if (!refreshToken) {
    return jsonError('invalid_request', 'refresh_token required');
  }

  const tokenData = await getRefreshToken(env.OAUTH_KV, refreshToken);

  if (!tokenData) {
    return jsonError('invalid_grant', 'Invalid or expired refresh token');
  }

  if (tokenData.clientId !== clientId) {
    return jsonError('invalid_grant', 'Token was not issued to this client');
  }

  // Revoke old refresh token
  await deleteRefreshToken(env.OAUTH_KV, refreshToken);

  // Issue new tokens
  return issueTokens(env, clientId, tokenData.userId, tokenData.email, tokenData.scope);
}

async function issueTokens(
  env: OAuthEnv,
  clientId: string,
  userId: string,
  email: string,
  scope: string
): Promise<Response> {
  const accessToken = generateToken(32);
  const refreshToken = generateToken(32);

  await storeAccessToken(env.OAUTH_KV, accessToken, {
    clientId,
    userId,
    email,
    scope,
    issuedAt: Date.now(),
  });

  await storeRefreshToken(env.OAUTH_KV, refreshToken, {
    clientId,
    userId,
    email,
    scope,
  });

  console.log(`[TOKEN] Issued tokens for: ${email}`);

  return new Response(
    JSON.stringify({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refreshToken,
      scope,
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    }
  );
}

// PKCE verification
async function verifyPKCE(codeVerifier: string, codeChallenge: string, method: string | null): Promise<boolean> {
  if (method === 'S256') {
    const encoder = new TextEncoder();
    const data = encoder.encode(codeVerifier);
    const hash = await crypto.subtle.digest('SHA-256', data);
    const base64 = btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    return base64 === codeChallenge;
  } else if (method === 'plain' || !method) {
    return codeVerifier === codeChallenge;
  }
  return false;
}

// =============================================================================
// Dynamic Client Registration Handler
// =============================================================================

/**
 * Handle Dynamic Client Registration (RFC 7591).
 *
 * Allows MCP clients to register themselves and obtain client credentials.
 */
export async function registerHandler(request: Request, env: OAuthEnv): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
  }

  const body = (await request.json()) as DCRRequest;

  const clientName = body.client_name || 'Unknown Client';
  const redirectUris = body.redirect_uris || [];
  const grantTypes = body.grant_types || ['authorization_code', 'refresh_token'];
  const responseTypes = body.response_types || ['code'];
  const scope = body.scope || 'mcp';

  if (redirectUris.length === 0) {
    return jsonError('invalid_request', 'At least one redirect_uri required');
  }

  // Generate client credentials
  const clientId = generateToken(16);
  const clientSecret = generateToken(32);

  console.log(`[DCR] Registering client: ${clientName}, id: ${clientId}`);

  const client = {
    client_id: clientId,
    client_secret: clientSecret,
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    response_types: responseTypes,
    scope,
    created_at: Date.now(),
  };

  await storeClient(env.OAUTH_KV, clientId, client);

  return new Response(
    JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: responseTypes,
      scope,
    }),
    {
      status: 201,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    }
  );
}

// =============================================================================
// Token Validation
// =============================================================================

/**
 * Validate an access token from the Authorization header.
 *
 * @returns Token data if valid, null otherwise
 */
export async function validateAccessToken(
  request: Request,
  env: OAuthEnv
): Promise<{ userId: string; email: string; scope: string } | null> {
  const authHeader = request.headers.get('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.slice(7);
  const tokenData = await getAccessToken(env.OAUTH_KV, token);

  if (tokenData) {
    console.log(`[VALIDATE] Token valid for user: ${tokenData.email}`);
  }

  return tokenData;
}
