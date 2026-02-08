/**
 * Tool registry for MCP servers.
 *
 * Manages tool definitions and dispatches tool calls.
 * Tools are registered with their definitions and handlers,
 * and can be executed by name.
 */

import type {
  Tool,
  McpToolDefinition,
  ToolResult,
  ToolContext,
  ToolHandler,
  ToolInputSchema,
  ToolAnnotations,
  TextContent,
} from './types.js';

/**
 * Registry for MCP tools.
 * Stores tool definitions and handlers, provides lookup and execution.
 */
export class ToolRegistry<TEnv = unknown> {
  private tools: Map<string, Tool<Record<string, unknown>, TEnv>> = new Map();

  /**
   * Register a single tool.
   */
  register<TArgs extends Record<string, unknown>>(tool: Tool<TArgs, TEnv>): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool as Tool<Record<string, unknown>, TEnv>);
    return this;
  }

  /**
   * Register multiple tools at once.
   */
  registerAll(tools: Tool<Record<string, unknown>, TEnv>[]): this {
    for (const tool of tools) {
      this.register(tool);
    }
    return this;
  }

  /**
   * Get tool definitions for the tools/list response.
   * Returns definitions without handlers.
   */
  getToolDefinitions(): McpToolDefinition[] {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    }));
  }

  /**
   * Check if a tool exists.
   */
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get a tool by name.
   */
  getTool(name: string): Tool<Record<string, unknown>, TEnv> | undefined {
    return this.tools.get(name);
  }

  /**
   * Execute a tool by name.
   *
   * @throws Error if tool not found
   */
  async executeTool(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext<TEnv>
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    return tool.handler(args, context);
  }

  /**
   * Get the number of registered tools.
   */
  get size(): number {
    return this.tools.size;
  }

  /**
   * Get all tool names.
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }
}

/**
 * Create a new tool registry.
 */
export function createToolRegistry<TEnv = unknown>(
  tools?: Tool<Record<string, unknown>, TEnv>[]
): ToolRegistry<TEnv> {
  const registry = new ToolRegistry<TEnv>();
  if (tools) {
    registry.registerAll(tools);
  }
  return registry;
}

// ============================================================================
// Tool Builder Helpers
// ============================================================================

/**
 * Helper to create a text content response.
 */
export function textContent(text: string): TextContent {
  return { type: 'text', text };
}

/**
 * Helper to create a successful tool result with text.
 */
export function textResult(text: string): ToolResult {
  return {
    content: [textContent(text)],
  };
}

/**
 * Helper to create a successful tool result with JSON.
 */
export function jsonResult(data: unknown, pretty = true): ToolResult {
  const text = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  return {
    content: [textContent(text)],
  };
}

/**
 * Helper to create an error tool result.
 */
export function errorResult(message: string): ToolResult {
  return {
    content: [textContent(message)],
    isError: true,
  };
}

/**
 * Type-safe tool definition helper.
 * Provides better type inference for tool arguments.
 */
export function defineTool<TArgs extends Record<string, unknown>, TEnv = unknown>(
  definition: {
    name: string;
    description: string;
    inputSchema: ToolInputSchema;
    annotations?: ToolAnnotations;
    handler: ToolHandler<TArgs, TEnv>;
  }
): Tool<TArgs, TEnv> {
  return definition;
}

// ============================================================================
// Common Input Schemas
// ============================================================================

/**
 * Common schema patterns for reuse.
 */
export const schemas = {
  /** String property */
  string: (description: string) => ({
    type: 'string' as const,
    description,
  }),

  /** Number property */
  number: (description: string, options?: { minimum?: number; maximum?: number }) => ({
    type: 'number' as const,
    description,
    ...options,
  }),

  /** Integer property */
  integer: (description: string, options?: { minimum?: number; maximum?: number }) => ({
    type: 'integer' as const,
    description,
    ...options,
  }),

  /** Boolean property */
  boolean: (description: string, defaultValue?: boolean) => ({
    type: 'boolean' as const,
    description,
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
  }),

  /** Array of strings */
  stringArray: (description: string) => ({
    type: 'array' as const,
    description,
    items: { type: 'string' as const },
  }),

  /** Enum property */
  enum: <T extends string>(description: string, values: T[]) => ({
    type: 'string' as const,
    description,
    enum: values,
  }),
};
