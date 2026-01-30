/**
 * MCP Authentication Middleware
 *
 * Provides Hono middleware for protecting MCP routes with OAuth authentication.
 */

import type { Context, MiddlewareHandler } from 'hono';
import type { OAuthEnv } from './types.js';
import { validateAccessToken } from './oauth-provider.js';

/** Token data returned by validateAccessToken */
export interface ValidatedTokenData {
  userId: string;
  email: string;
  scope: string;
}

/**
 * Get the issuer URL from environment or request.
 * Uses loose context type to work with any Hono app configuration.
 */
export function getIssuerUrl(c: { env?: { ISSUER_URL?: string }; req: { url: string } }): string {
  return c.env?.ISSUER_URL || new URL(c.req.url).origin;
}

/**
 * Create an MCP authentication middleware.
 *
 * Validates OAuth access tokens and returns 401 with proper WWW-Authenticate
 * header if authentication fails.
 *
 * @param options.allowServiceToken - Also accept CF Access service tokens (default: true)
 * @param options.onSuccess - Callback with token data on successful auth
 */
export function mcpAuthMiddleware<T extends OAuthEnv>(options?: {
  allowServiceToken?: boolean;
  onSuccess?: (c: Context<{ Bindings: T }>, tokenData: ValidatedTokenData) => void;
}): MiddlewareHandler<{ Bindings: T }> {
  const { allowServiceToken = true, onSuccess } = options || {};

  return async (c, next) => {
    // Check for OAuth token first
    const tokenData = await validateAccessToken(c.req.raw, c.env);

    if (tokenData) {
      console.log(`[MCP] Authenticated via OAuth: ${tokenData.email}`);
      if (onSuccess) {
        onSuccess(c, tokenData);
      }
      await next();
      return;
    }

    // Fallback to CF Access service token if allowed
    if (allowServiceToken) {
      const serviceTokenId = c.req.header('CF-Access-Client-Id');
      const serviceTokenSecret = c.req.header('CF-Access-Client-Secret');
      const expectedTokenId = c.env?.CF_ACCESS_SERVICE_TOKEN_ID;

      if (serviceTokenId && serviceTokenSecret) {
        // Validate token ID if configured
        if (expectedTokenId && serviceTokenId !== expectedTokenId) {
          console.log('[MCP] Invalid service token ID - rejecting');
          // Continue to OAuth check failure (don't silently accept invalid tokens)
        } else {
          console.log('[MCP] Authenticated via CF Access service token');
          await next();
          return;
        }
      }
    }

    // No valid authentication - return 401 with OAuth discovery hint
    const issuer = getIssuerUrl(c);
    console.log('[MCP] No valid authentication, returning 401');
    return new Response('Unauthorized', {
      status: 401,
      headers: {
        'WWW-Authenticate': `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`,
        'Content-Type': 'text/plain',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'Mcp-Session-Id',
      },
    });
  };
}

/**
 * Create OAuth discovery metadata routes for a Hono app.
 *
 * Returns an object with handlers for:
 * - /.well-known/oauth-authorization-server
 * - /.well-known/oauth-protected-resource
 *
 * Uses loose types to work with any Hono app configuration.
 */
export function createOAuthDiscoveryHandlers() {
  return {
    /**
     * OAuth Authorization Server Metadata (RFC 8414)
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    authorizationServer: (c: any) => {
      const issuer = getIssuerUrl(c);
      return c.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256', 'plain'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        scopes_supported: ['mcp', 'openid', 'profile', 'email'],
      });
    },

    /**
     * OAuth Protected Resource Metadata (RFC 9728)
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protectedResource: (c: any) => {
      const issuer = getIssuerUrl(c);
      console.log(`[OAUTH] Serving protected resource metadata for: ${issuer}`);
      return c.json({
        resource: issuer, // Base URL only - matches reference implementation
        authorization_servers: [issuer],
        scopes_supported: ['mcp'],
        bearer_methods_supported: ['header'],
      });
    },
  };
}
