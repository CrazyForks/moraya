/**
 * LLM API adapters — now a thin wrapper over the shared @moraya/core/ai layer.
 *
 * Provider catalog, request building, and response/SSE/tool parsing live in
 * @moraya/core/ai (baselined on this app). Execution stays desktop-specific via
 * TauriAITransport (Rust ai_proxy_* + Keychain). Public function signatures are
 * unchanged so ai-service.ts / seo-service.ts / AIChatPanel etc. are untouched.
 */
import type { AIProviderConfig, AIRequest, AIResponse, StreamToolResult } from './types';
import { sendChat, streamChat, openaiEndpoint as coreOpenaiEndpoint } from '@moraya/core/ai';
import type { AIProviderConfig as CoreConfig, AIRequest as CoreRequest } from '@moraya/core/ai';
import { TauriAITransport } from './adapters/tauri-ai-transport';

const transport = new TauriAITransport();

/** Re-exported so existing importers (image-service, etc.) keep resolving it. */
export function openaiEndpoint(baseUrl: string, path: string): string {
  return coreOpenaiEndpoint(baseUrl, path);
}

export async function sendAIRequest(
  config: AIProviderConfig,
  request: AIRequest,
  signal?: AbortSignal,
): Promise<AIResponse> {
  const res = await sendChat(config as CoreConfig, request as CoreRequest, transport, signal);
  return res as AIResponse;
}

export async function* streamAIRequest(
  config: AIProviderConfig,
  request: AIRequest,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  for await (const ev of streamChat(config as CoreConfig, request as CoreRequest, transport, signal)) {
    if (ev.delta) yield ev.delta;
  }
}

/**
 * Streaming with tool-call support. Streams text via `onTextChunk` and returns
 * the assembled result (incl. tool calls). The core orchestrator handles the
 * \x02 / SSE parsing; this wrapper folds the unified stream events.
 */
export async function streamAIRequestWithTools(
  config: AIProviderConfig,
  request: AIRequest,
  signal?: AbortSignal,
  onTextChunk?: (chunk: string) => void,
): Promise<StreamToolResult> {
  let content = '';
  let toolCalls: StreamToolResult['toolCalls'];
  let stopReason = 'end_turn';
  for await (const ev of streamChat(config as CoreConfig, request as CoreRequest, transport, signal)) {
    if (ev.delta) { content += ev.delta; onTextChunk?.(ev.delta); }
    if (ev.done) {
      if (ev.toolCalls) toolCalls = ev.toolCalls;
      if (ev.stopReason) stopReason = ev.stopReason;
    }
  }
  return { content, ...(toolCalls ? { toolCalls } : {}), stopReason };
}
