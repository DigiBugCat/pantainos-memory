/**
 * JSON-RPC 2.0 message handling for MCP protocol.
 *
 * Handles the core MCP methods:
 * - initialize: Capability negotiation
 * - initialized: Acknowledgment (notification, no response)
 * - tools/list: Returns available tools
 * - tools/call: Executes a tool
 * - ping: Health check
 */

import type {
  JsonRpcRequest,
  JsonRpcResponse,
  McpInitializeResult,
  McpServerInfo,
  McpCapabilities,
  ToolsListResult,
  ToolsCallParams,
  ToolResult,
  ToolContext,
} from './types.js';
import { JsonRpcErrorCode, MCP_PROTOCOL_VERSION } from './types.js';
import type { ToolRegistry } from './tool-registry.js';

export interface McpServerOptions<TEnv = unknown> {
  /** Server name for initialize response */
  name: string;
  /** Server version */
  version: string;
  /** Tool registry containing available tools */
  toolRegistry: ToolRegistry<TEnv>;
}

/**
 * Create a JSON-RPC error response.
 */
export function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, data },
  };
}

/**
 * Create a JSON-RPC success response.
 */
export function jsonRpcSuccess(
  id: string | number | null,
  result: unknown
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

/**
 * Handle an MCP JSON-RPC message.
 *
 * @param message - The incoming JSON-RPC request
 * @param options - Server configuration and tool registry
 * @param context - User context for tool execution
 * @returns JSON-RPC response, or null for notifications
 */
export async function handleMcpMessage<TEnv>(
  message: JsonRpcRequest,
  options: McpServerOptions<TEnv>,
  context: ToolContext<TEnv>
): Promise<JsonRpcResponse | null> {
  const { method, id, params } = message;

  // Validate JSON-RPC version
  if (message.jsonrpc !== '2.0') {
    return jsonRpcError(
      id ?? null,
      JsonRpcErrorCode.INVALID_REQUEST,
      'Invalid JSON-RPC version'
    );
  }

  try {
    switch (method) {
      case 'initialize':
        return handleInitialize(id, options);

      case 'initialized':
        // Notification - no response
        return null;

      case 'tools/list':
        return handleToolsList(id, options.toolRegistry);

      case 'tools/call':
        return await handleToolsCall(id, params as ToolsCallParams | undefined, options.toolRegistry, context);

      case 'ping':
        return jsonRpcSuccess(id ?? null, {});

      case 'notifications/cancelled':
        // Client cancelled a request - acknowledge but no response needed
        return null;

      default:
        return jsonRpcError(
          id ?? null,
          JsonRpcErrorCode.METHOD_NOT_FOUND,
          `Method not found: ${method}`
        );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return jsonRpcError(
      id ?? null,
      JsonRpcErrorCode.INTERNAL_ERROR,
      errorMessage
    );
  }
}

/**
 * Handle the 'initialize' method.
 * Returns server info and capabilities.
 */
function handleInitialize<TEnv>(
  id: string | number | undefined,
  options: McpServerOptions<TEnv>
): JsonRpcResponse {
  const serverInfo: McpServerInfo = {
    name: options.name,
    version: options.version,
  };

  const capabilities: McpCapabilities = {
    tools: {},
  };

  const result: McpInitializeResult = {
    protocolVersion: MCP_PROTOCOL_VERSION,
    serverInfo,
    capabilities,
  };

  return jsonRpcSuccess(id ?? null, result);
}

/**
 * Handle the 'tools/list' method.
 * Returns all available tool definitions.
 */
function handleToolsList<TEnv>(
  id: string | number | undefined,
  registry: ToolRegistry<TEnv>
): JsonRpcResponse {
  const result: ToolsListResult = {
    tools: registry.getToolDefinitions(),
  };

  return jsonRpcSuccess(id ?? null, result);
}

/**
 * Handle the 'tools/call' method.
 * Executes the named tool with provided arguments.
 */
async function handleToolsCall<TEnv>(
  id: string | number | undefined,
  params: ToolsCallParams | undefined,
  registry: ToolRegistry<TEnv>,
  context: ToolContext<TEnv>
): Promise<JsonRpcResponse> {
  if (!params?.name) {
    return jsonRpcError(
      id ?? null,
      JsonRpcErrorCode.INVALID_PARAMS,
      'Missing tool name'
    );
  }

  const { name, arguments: args = {} } = params;

  try {
    const result = await registry.executeTool(name, args, context);
    return jsonRpcSuccess(id ?? null, result);
  } catch (error) {
    // Tool execution errors are returned as tool results with isError flag
    const errorMessage = error instanceof Error ? error.message : 'Tool execution failed';
    const errorResult: ToolResult = {
      content: [{ type: 'text', text: errorMessage }],
      isError: true,
    };
    return jsonRpcSuccess(id ?? null, errorResult);
  }
}

/**
 * Parse a JSON-RPC request from a string.
 * Returns the parsed request or an error response.
 */
export function parseJsonRpcRequest(
  body: string
): { request: JsonRpcRequest } | { error: JsonRpcResponse } {
  try {
    const parsed = JSON.parse(body);

    // Basic validation
    if (typeof parsed !== 'object' || parsed === null) {
      return {
        error: jsonRpcError(null, JsonRpcErrorCode.INVALID_REQUEST, 'Invalid request object'),
      };
    }

    if (typeof parsed.method !== 'string') {
      return {
        error: jsonRpcError(
          parsed.id ?? null,
          JsonRpcErrorCode.INVALID_REQUEST,
          'Missing or invalid method'
        ),
      };
    }

    return { request: parsed as JsonRpcRequest };
  } catch {
    return {
      error: jsonRpcError(null, JsonRpcErrorCode.PARSE_ERROR, 'Parse error'),
    };
  }
}
