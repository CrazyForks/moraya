/**
 * Claude Code transcript parsing + denoise + candidate extraction.
 *
 * Pure functions only — no Tauri/IPC — so the extraction logic is unit-testable
 * without a runtime. The Tauri-facing orchestration lives in `import-service.ts`.
 *
 * Transcript format (`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`):
 * one JSON object per line. Genuine user prompts are `type:"user"` entries whose
 * `message.content` is a string or an array of `{type:"text"}` blocks. The same
 * `type:"user"` shape is reused for tool results, image/meta injections and
 * slash-command echoes, so those must be filtered out. See docs/specs/prompt-asset.md.
 */
import type { DropReason, PromptCandidate } from './types'

/** Minimum length (in code points) for a message to default to "likely prompt". */
export const MIN_LIKELY_LEN = 12

/**
 * Short acknowledgements that are never requirement prompts. Compared against
 * the trimmed, lower-cased message. CJK variants included per the i18n policy of
 * matching user data created in any locale.
 */
const CONFIRMATIONS = new Set([
  'continue', 'go', 'go on', 'go ahead', 'proceed', 'next', 'done',
  'yes', 'y', 'yeah', 'yep', 'ok', 'okay', 'sure', 'fine',
  'thanks', 'thank you', 'please continue', 'keep going', 'stop', 'wait',
  '继续', '继续吧', '好', '好的', '嗯', '行', '可以', '对', '是', '是的',
  '谢谢', '停', '停止', '等等', '下一步', '接着', '往下',
])

/**
 * Leading markers that identify a system-injected or slash-command message
 * masquerading as a user turn. Matched case-insensitively against the trimmed
 * text's start.
 */
const SYSTEM_TAG_PREFIXES = [
  '<task-notification>',
  '<system-reminder>',
  '<ide_selection>',
  '<ide_opened_file>',
  '<ide_diagnostics>',
  '[request interrupted',
  '[image:',
  'caveat: the messages below',
  'this session is being continued from a previous conversation',
]

/**
 * Wrapper tags the harness / IDE inject into a user turn. Their whole block
 * (open→close) is stripped before classification so a pure-injection message
 * becomes empty (and is dropped) while a real prompt that merely has an
 * injected block appended is cleaned rather than discarded.
 */
const INJECTED_TAGS = [
  'system-reminder',
  'task-notification',
  'ide_selection',
  'ide_opened_file',
  'ide_diagnostics',
  'command-message',
  'command-name',
  'command-args',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
]

const INJECTED_BLOCK_RE = new RegExp(
  `<(${INJECTED_TAGS.join('|')})\\b[^>]*>[\\s\\S]*?</\\1>`,
  'gi',
)

/** Remove injected wrapper blocks (with their content) and trim. */
export function stripInjectedBlocks(text: string): string {
  return text.replace(INJECTED_BLOCK_RE, '').trim()
}

const SLASH_COMMAND_MARKERS = [
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<local-command-caveat>',
]

/** Collapse whitespace runs and trim — for hashing/dedupe, not for storage. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** DJB2 hash → unsigned hex. Stable across runs; used for candidate keys. */
export function hashText(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h) ^ text.charCodeAt(i)
  }
  return (h >>> 0).toString(16)
}

/** Human-facing project label from an entry's `cwd`, falling back to the
 *  encoded transcript directory name (`-Users-me-Documents-app` → `app`). */
export function deriveProject(cwd: string | null | undefined, dirName: string): string {
  if (cwd && typeof cwd === 'string') {
    const base = cwd.split('/').filter(Boolean).pop()
    if (base) return base
  }
  const seg = dirName.split('-').filter(Boolean).pop()
  return seg || dirName || 'unknown'
}

/** Decide whether a user message is a keepable prompt, and if not, why. */
export function classify(
  text: string,
  flags: { isMeta?: boolean; isSidechain?: boolean; isCompactSummary?: boolean },
): DropReason | null {
  if (flags.isMeta || flags.isCompactSummary) return 'meta'
  if (flags.isSidechain) return 'sidechain'
  const trimmed = text.trim()
  if (!trimmed) return 'empty'
  const lower = trimmed.toLowerCase()
  if (SLASH_COMMAND_MARKERS.some(m => lower.includes(m))) return 'slash-command'
  if (SYSTEM_TAG_PREFIXES.some(p => lower.startsWith(p))) return 'system-tag'
  return null
}

/** Whether a kept message defaults to selected in the preview. */
export function isLikelyPrompt(text: string): boolean {
  const trimmed = text.trim()
  if (CONFIRMATIONS.has(trimmed.toLowerCase())) return false
  return [...trimmed].length >= MIN_LIKELY_LEN
}

/** Pull the typed text out of a `message.content` value, or null if the turn is
 *  a tool result / has no text. */
function extractText(content: unknown): { text: string | null; toolResult: boolean } {
  if (typeof content === 'string') return { text: content, toolResult: false }
  if (Array.isArray(content)) {
    const hasToolResult = content.some(
      b => b && typeof b === 'object' && (b as { type?: string }).type === 'tool_result',
    )
    if (hasToolResult) return { text: null, toolResult: true }
    const texts = content
      .filter(b => b && typeof b === 'object' && (b as { type?: string }).type === 'text')
      .map(b => (b as { text?: string }).text ?? '')
    const joined = texts.join('\n').trim()
    return { text: joined || null, toolResult: false }
  }
  return { text: null, toolResult: false }
}

/**
 * Extract genuine user-prompt candidates from one transcript's raw JSONL text.
 * Malformed lines are skipped. Non-prompt lines are dropped per {@link classify}.
 */
export function extractCandidates(
  jsonl: string,
  ctx: { sessionId: string; dirName: string },
): PromptCandidate[] {
  const out: PromptCandidate[] = []
  for (const line of jsonl.split('\n')) {
    const trimmedLine = line.trim()
    if (!trimmedLine) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(trimmedLine)
    } catch {
      continue
    }
    if (obj.type !== 'user') continue
    const msg = obj.message
    if (!msg || typeof msg !== 'object') continue
    const { text: rawText, toolResult } = extractText((msg as { content?: unknown }).content)
    if (toolResult || !rawText) continue
    // Strip harness/IDE-injected wrapper blocks so the stored prompt is clean
    // and pure-injection turns collapse to empty (then dropped by classify).
    const text = stripInjectedBlocks(rawText)

    const reason = classify(text, {
      isMeta: obj.isMeta === true,
      isSidechain: obj.isSidechain === true,
      isCompactSummary: obj.isCompactSummary === true,
    })
    if (reason) continue

    const sessionId = typeof obj.sessionId === 'string' ? obj.sessionId : ctx.sessionId
    const sentAt = typeof obj.timestamp === 'string' ? obj.timestamp : ''
    const project = deriveProject(obj.cwd as string | undefined, ctx.dirName)
    out.push({
      key: `${sessionId}:${hashText(normalizeText(text))}`,
      sessionId,
      project,
      sentAt,
      text,
      likely: isLikelyPrompt(text),
    })
  }
  return out
}

/** Drop duplicate candidates (same key), keeping the first occurrence. */
export function dedupe(candidates: PromptCandidate[]): PromptCandidate[] {
  const seen = new Set<string>()
  const out: PromptCandidate[] = []
  for (const c of candidates) {
    if (seen.has(c.key)) continue
    seen.add(c.key)
    out.push(c)
  }
  return out
}
