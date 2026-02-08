/**
 * MCP (Model Context Protocol) type definitions.
 *
 * Based on the MCP specification (2024-11-05 protocol version).
 * These types are used for implementing MCP servers on Cloudflare Workers.
 *
 * @see https://modelcontextprotocol.io/specification
 */

// ============================================================================
// JSON-RPC 2.0 Base Types
// ============================================================================

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** JSON-RPC 2.0 error codes */
export const JsonRpcErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

// ============================================================================
// MCP Protocol Types
// ============================================================================

/** MCP protocol version supported by this implementation */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpCapabilities {
  tools?: Record<string, never>;
  resources?: Record<string, never>;
  prompts?: Record<string, never>;
}

export interface McpInitializeResult {
  protocolVersion: string;
  serverInfo: McpServerInfo;
  capabilities: McpCapabilities;
}

// ============================================================================
// Tool Types
// ============================================================================

/**
 * JSON Schema for tool input validation.
 * Simplified version covering common use cases.
 */
export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, ToolPropertySchema>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolPropertySchema {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: (string | number | boolean)[];
  items?: ToolPropertySchema;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

/**
 * Tool annotations providing hints about tool behavior.
 * Per MCP spec: these are hints, not guarantees.
 */
export interface ToolAnnotations {
  /** Human-readable title for the tool */
  title?: string;
  /** If true, the tool does not modify its environment (default: false) */
  readOnlyHint?: boolean;
  /** If true, the tool may perform destructive updates (default: true, only meaningful when readOnlyHint is false) */
  destructiveHint?: boolean;
  /** If true, repeated calls with same args have no additional effect (default: false, only meaningful when readOnlyHint is false) */
  idempotentHint?: boolean;
  /** If true, tool interacts with external entities (default: true) */
  openWorldHint?: boolean;
}

/**
 * Tool definition exposed to MCP clients.
 * Does not include the handler function.
 */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  annotations?: ToolAnnotations;
}

/**
 * Tool content types for responses.
 */
export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  data: string; // base64 encoded
  mimeType: string;
}

export interface ResourceContent {
  type: 'resource';
  resource: {
    uri: string;
    text?: string;
    blob?: string;
    mimeType?: string;
  };
}

export type ToolContent = TextContent | ImageContent | ResourceContent;

/**
 * Result returned from tool execution.
 */
export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

/**
 * Context provided to tool handlers.
 */
export interface ToolContext<TEnv = unknown> {
  /** User identity (email from CF Access) */
  userEmail: string;
  /** Worker environment bindings */
  env: TEnv;
  /** Optional session ID for conversation tracking */
  sessionId?: string;
}

/**
 * Tool handler function signature.
 */
export type ToolHandler<TArgs = Record<string, unknown>, TEnv = unknown> = (
  args: TArgs,
  context: ToolContext<TEnv>
) => Promise<ToolResult>;

/**
 * Complete tool definition including handler.
 * Used internally for tool registration.
 */
export interface Tool<TArgs = Record<string, unknown>, TEnv = unknown> {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  annotations?: ToolAnnotations;
  handler: ToolHandler<TArgs, TEnv>;
}

// ============================================================================
// MCP Request/Response Types
// ============================================================================

export interface ToolsListResult {
  tools: McpToolDefinition[];
}

export interface ToolsCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

// ============================================================================
// Auth Types (Cloudflare Access)
// ============================================================================

/**
 * Claims from a Cloudflare Access JWT.
 */
export interface CfAccessClaims {
  /** Audience tag(s) */
  aud: string | string[];
  /** User email */
  email: string;
  /** Expiration timestamp (seconds) */
  exp: number;
  /** Issued at timestamp (seconds) */
  iat: number;
  /** Issuer URL */
  iss: string;
  /** Subject (user ID) */
  sub: string;
  /** Token type */
  type: string;
  /** Identity nonce */
  identity_nonce?: string;
  /** User's country */
  country?: string;
}

/**
 * User identity extracted from auth.
 */
export interface McpUserIdentity {
  email: string;
  sub?: string;
  name?: string;
}
