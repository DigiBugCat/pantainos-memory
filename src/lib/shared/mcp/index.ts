/**
 * MCP (Model Context Protocol) shared library.
 *
 * Provides types, JSON-RPC handling, and tool registry
 * for implementing MCP servers on Cloudflare Workers.
 */

// Types
export type {
  // JSON-RPC
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  // MCP Protocol
  McpServerInfo,
  McpCapabilities,
  McpInitializeResult,
  // Tools
  ToolAnnotations,
  ToolInputSchema,
  ToolPropertySchema,
  McpToolDefinition,
  TextContent,
  ImageContent,
  ResourceContent,
  ToolContent,
  ToolResult,
  ToolContext,
  ToolHandler,
  Tool,
  ToolsListResult,
  ToolsCallParams,
  // Auth
  CfAccessClaims,
  McpUserIdentity,
} from './types.js';

export { JsonRpcErrorCode, MCP_PROTOCOL_VERSION } from './types.js';

// JSON-RPC handling
export {
  handleMcpMessage,
  jsonRpcError,
  jsonRpcSuccess,
  parseJsonRpcRequest,
  type McpServerOptions,
} from './json-rpc.js';

// Tool registry
export {
  ToolRegistry,
  createToolRegistry,
  textContent,
  textResult,
  jsonResult,
  errorResult,
  defineTool,
  schemas,
} from './tool-registry.js';
