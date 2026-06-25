/**
 * Desktop AITransport — executes requests built by @moraya/core/ai through the
 * Rust `ai_proxy_*` commands. The Rust side injects the API key from the OS
 * Keychain (by configId) and adds the provider auth header, so the real key
 * never enters the WebView. The only exception is the explicit paste/dev
 * override (config.apiKey !== '***'), preserved verbatim from the old
 * providers.ts proxyFetch/streamViaProxy.
 */
import { invoke, Channel } from '@tauri-apps/api/core'
import type { AITransport, TransportRequest, TransportResponse, StreamCallbacks } from '@moraya/core/ai'
import type { AIProvider } from '@moraya/core/ai'

/** The driver leaves `apiKey` as the config value; on desktop that's the
 *  `'***'` sentinel (key in Keychain) unless the user pasted a raw key. */
function override(apiKey?: string): string | undefined {
  return apiKey && apiKey !== '***' ? apiKey : undefined
}

function headersOrUndefined(headers: Record<string, string>): Record<string, string> | undefined {
  return Object.keys(headers).length > 0 ? headers : undefined
}

/** Rust has no SSE path for gemini/ollama — one-shot them (matches legacy PC). */
const TOOL_EVENT_PREFIX = '\x02'
const CHUNK_TIMEOUT_MS = 120_000

export class TauriAITransport implements AITransport {
  canStream(provider: AIProvider): boolean {
    return provider !== 'gemini' && provider !== 'ollama'
  }

  async fetch(req: TransportRequest, signal?: AbortSignal): Promise<TransportResponse> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const requestId = signal ? crypto.randomUUID() : undefined
    if (signal && requestId) {
      signal.addEventListener('abort', () => { invoke('ai_proxy_abort', { requestId }).catch(() => {}) }, { once: true })
    }
    try {
      const responseText = await invoke<string>('ai_proxy_fetch', {
        requestId,
        configId: req.configId,
        apiKeyOverride: override(req.apiKey),
        provider: req.provider,
        url: req.url,
        body: req.body,
        headers: headersOrUndefined(req.headers),
        keyPrefix: req.keyPrefix,
        method: req.method,
      })
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      return { status: 200, body: responseText }
    } catch (err) {
      if (signal?.aborted || (typeof err === 'string' && err.includes('Aborted'))) {
        throw new DOMException('Aborted', 'AbortError')
      }
      throw err
    }
  }

  async stream(req: TransportRequest, cb: StreamCallbacks): Promise<void> {
    const requestId = crypto.randomUUID()
    let lastChunkAt = Date.now()

    const channel = new Channel<string>()
    channel.onmessage = (text: string) => {
      lastChunkAt = Date.now()
      if (text.startsWith(TOOL_EVENT_PREFIX)) cb.onEnvelope(text.slice(1))
      else cb.onText(text)
    }

    if (cb.signal) {
      cb.signal.addEventListener('abort', () => { invoke('ai_proxy_abort', { requestId }).catch(() => {}) }, { once: true })
    }

    const streamPromise = invoke('ai_proxy_stream', {
      onEvent: channel,
      requestId,
      configId: req.configId,
      apiKeyOverride: override(req.apiKey),
      provider: req.provider,
      url: req.url,
      body: req.body,
      headers: headersOrUndefined(req.headers),
    })

    // Stall watchdog: if the provider drops the SSE connection without closing,
    // abort so the orchestrator doesn't hang forever.
    let settled = false
    const watchdog = new Promise<void>((_, reject) => {
      const timer = setInterval(() => {
        if (settled) { clearInterval(timer); return }
        if (Date.now() - lastChunkAt > CHUNK_TIMEOUT_MS) {
          clearInterval(timer)
          invoke('ai_proxy_abort', { requestId }).catch(() => {})
          reject(new Error(`Stream stalled: no data for ${CHUNK_TIMEOUT_MS / 1000}s`))
        }
      }, 5000)
    })

    try {
      await Promise.race([streamPromise.then(() => { settled = true }), watchdog])
    } catch (err) {
      settled = true
      if (cb.signal?.aborted || (typeof err === 'string' && (err as string).includes('Aborted'))) {
        throw new DOMException('Aborted', 'AbortError')
      }
      throw err instanceof Error ? err : new Error(String(err))
    }
  }
}
