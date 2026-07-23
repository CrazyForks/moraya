/**
 * AI chat markdown renderer (PC desktop).
 *
 * Thin wrapper around `@moraya/core/chat-markdown` that wires the local
 * KaTeX + highlight.js peers. Keeps the call site (`AIChatPanel.svelte`)
 * to a single import and gives us a future hook point for mention pills,
 * citation badges, or other PC-specific pre-processing without touching
 * the shared core.
 *
 * Why this isn't `export-service.ts`'s `markdownToHtmlBody`:
 *   `markdownToHtmlBody` carries mermaid-export wrappers, table-of-
 *   contents anchors, and other HTML-export-only concerns. Chat needs
 *   the streaming-safe, security-hardened subset shared across PC/Web/
 *   Mobile — that lives in `@moraya/core/chat-markdown`.
 *
 * See moraya/docs/iterations/v0.42.0-core-chat-markdown.md.
 */

import { renderChatMarkdown as renderCore } from '@moraya/core/chat-markdown'
import katex from 'katex'
// Side-effect: register \ce/\pu (mhchem) for chemistry in chat bubbles.
import 'katex/contrib/mhchem'
import hljs from 'highlight.js'

/**
 * Render an LLM/user chat message to safe HTML for display in a chat bubble.
 *
 * Output is XSS-hardened (`html: false`, JS-URL deny, `rel="noopener"` on
 * every <a>) and streaming-safe (every call is idempotent; unclosed code
 * fences / math / links from partial SSE chunks degrade gracefully).
 */
export function renderChatMarkdown(content: string): string {
  return renderCore(content, {
    math: (latex, displayMode) =>
      katex.renderToString(latex, { displayMode, throwOnError: false }),
    highlight: (code, lang) => {
      if (!lang) return null
      if (!hljs.getLanguage(lang)) return null
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
      } catch {
        return null
      }
    },
  })
}
