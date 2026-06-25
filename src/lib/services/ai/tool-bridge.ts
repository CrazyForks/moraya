/**
 * Tool Bridge — provider tool formatting + response parsing now live in
 * @moraya/core/ai (shared with the web app). This module re-exports them and
 * keeps the MCP-specific glue (mcpToolsToToolDefs) that has no place in core.
 */
import type { MCPTool } from '$lib/services/mcp/types';
import type { ToolDefinition } from './types';

export {
  formatToolsForProvider,
  parseClaudeToolCalls,
  parseOpenAIToolCalls,
  parseGeminiToolCalls,
  buildClaudeToolResultMessages,
  buildOpenAIToolResultMessages,
} from '@moraya/core/ai';

/**
 * Convert MCP tools to generic ToolDefinition format.
 * MCP tools already use JSON Schema for inputSchema, so mapping is direct.
 */
export function mcpToolsToToolDefs(tools: MCPTool[]): ToolDefinition[] {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}
