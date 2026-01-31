/**
 * MCP Server OAuth Module
 *
 * Provides OAuth 2.0 authentication for MCP (Model Context Protocol) workers,
 * backed by Cloudflare Access for identity verification.
 */

// Types
export type {
  OAuthEnv,
  CFAccessJWT,
  UserInfo,
  AuthorizationState,
  OAuthClient,
  AuthCodeData,
  AccessTokenData,
  RefreshTokenData,
  DCRRequest,
  TokenRequest,
} from './types.js';

// OAuth Provider (main handlers)
export {
  authorizeHandler,
  tokenHandler,
  registerHandler,
  validateAccessToken,
} from './oauth-provider.js';

// KV Storage helpers
export {
  storeClient,
  getClient,
  storeAuthCode,
  getAuthCode,
  storeAccessToken,
  getAccessToken,
  storeRefreshToken,
  getRefreshToken,
  deleteRefreshToken,
  storeAuthState,
  getAuthState,
} from './oauth-kv.js';

// CF Access JWT handling
export {
  verifyCFAccessJWT,
  extractUserInfo,
  getCFAccessJWT,
  getCFAccessLoginUrl,
} from './access-handler.js';

// Middleware
export {
  getIssuerUrl,
  mcpAuthMiddleware,
  createOAuthDiscoveryHandlers,
  type ValidatedTokenData,
} from './middleware.js';
