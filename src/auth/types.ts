/**
 * OAuth types for MCP authentication with Cloudflare Access
 */

// Environment bindings required for OAuth
// These are optional at the type level but required at runtime for OAuth to work
export interface OAuthEnv {
  OAUTH_KV: KVNamespace;
  ISSUER_URL?: string;
  CF_ACCESS_TEAM?: string;
  CF_ACCESS_AUD?: string;
}

// CF Access JWT claims
export interface CFAccessJWT {
  aud: string[];
  email: string;
  exp: number;
  iat: number;
  iss: string;
  sub: string;
  type: string;
  identity_nonce: string;
  country: string;
}

// User info extracted from CF Access
export interface UserInfo {
  id: string;
  email: string;
  name?: string;
}

// OAuth authorization request state
export interface AuthorizationState {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}

// Stored OAuth client from DCR
export interface OAuthClient {
  client_id: string;
  client_secret?: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  scope: string;
  created_at: number;
}

// Stored authorization code data
export interface AuthCodeData {
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  userId: string;
  email: string;
  issuedAt: number;
}

// Stored access token data
export interface AccessTokenData {
  clientId: string;
  userId: string;
  email: string;
  scope: string;
  issuedAt: number;
}

// Stored refresh token data
export interface RefreshTokenData {
  clientId: string;
  userId: string;
  email: string;
  scope: string;
}
