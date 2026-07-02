/**
 * MCP shortcut action helpers — v0.41.6.
 *
 * Two action types are dispatched from the `runShortcutAction` switch in
 * `+page.svelte` when a user presses a combo bound to an `mcp.*` catalog id:
 *
 *   - `toggleMCPServer(serverId)` — connects an installed-but-disconnected
 *     server (or disconnects a connected one). Mirrors what the user does
 *     by clicking the toggle in the MCP settings panel.
 *
 *   - `mcpToolPromptMessage(server, tool)` — builds the localized "please
 *     use the {tool} tool from {server}" message; same template the
 *     native Workflow → MCP Tools submenu uses on tool-click
 *     (see `+page.svelte` `mcp-tool-clicked` listener at v0.41.5).
 *
 * The "send message + show AI panel" side effect is intentionally NOT
 * baked in here — the caller orchestrates `showAIPanel = true` + a call
 * to `sendChatMessage(message, content)` because both pieces are bound
 * to component-level state.
 */

import { get } from 'svelte/store';
import { t } from '$lib/i18n';
import { mcpStore, connectServer, disconnectServer } from './mcp-manager';
import type { MCPServerConfig, MCPTool } from './types';

export type MCPToggleResult =
  | { kind: 'connected'; server: MCPServerConfig }
  | { kind: 'disconnected'; server: MCPServerConfig }
  | { kind: 'not-found'; serverId: string }
  | { kind: 'error'; serverId: string; reason: string };

/**
 * Flip the connected state of an MCP server.
 *
 * - If the server isn't installed, returns `not-found`.
 * - If currently connected, runs `disconnectServer` → returns `disconnected`.
 * - If currently disconnected, runs `connectServer` → returns `connected`.
 *
 * Side effects:
 *   - `mcpStore.setConnected(...)` is updated by the underlying connect /
 *     disconnect functions (no extra bookkeeping needed here).
 *   - Caller is responsible for surfacing a toast based on the return value.
 */
export async function toggleMCPServer(serverId: string): Promise<MCPToggleResult> {
  const state = get(mcpStore);
  const server = state.servers.find(s => s.id === serverId);
  if (!server) return { kind: 'not-found', serverId };

  const isConnected = state.connectedServers.has(serverId);
  try {
    if (isConnected) {
      await disconnectServer(serverId);
      return { kind: 'disconnected', server };
    } else {
      await connectServer({ ...server, enabled: true });
      return { kind: 'connected', server };
    }
  } catch (e) {
    return {
      kind: 'error',
      serverId,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

export type MCPToolResolution =
  | { kind: 'ok'; server: MCPServerConfig; tool: MCPTool; message: string }
  | { kind: 'not-found' };

/**
 * Resolve a (serverId, toolName) ref to the localized prompt message
 * that should be sent to the AI panel. Returns the resolved
 * `server`/`tool` for caller-side bookkeeping.
 *
 * Uses the same i18n key (`ai.prompts.mcpToolPrompt`) the native menu's
 * `mcp-tool-clicked` listener uses, so the behavior is identical
 * whether the user fires the tool via menu click or via keyboard shortcut.
 */
export function resolveMCPToolPrompt(
  serverId: string,
  toolName: string,
): MCPToolResolution {
  const state = get(mcpStore);
  const server = state.servers.find(s => s.id === serverId);
  const tool = state.tools.find(x => x.serverId === serverId && x.name === toolName);
  if (!server || !tool) return { kind: 'not-found' };
  const tt = get(t);
  const message = tt('ai.prompts.mcp_tool_prompt', {
    toolName: tool.name,
    serverName: server.name,
  });
  return { kind: 'ok', server, tool, message };
}
