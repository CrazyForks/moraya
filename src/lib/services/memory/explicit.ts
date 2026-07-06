/**
 * `/memorize` command parsing (ported from web `src/lib/memory/explicit.ts`),
 * producing a `MemoryDoc`. Kind/domain/factType are heuristically inferred.
 */
import type { MemoryDoc, MemoryKind, FactType } from './types'
import { MEMORY_CONTENT_MAX_LEN } from './types'

const MEMORIZE_COMMAND_PREFIX = '/memorize'

export interface ParsedMemorizeCommand {
  content: string
  kind: MemoryKind
  domain?: string
  factType?: FactType
  projectName?: string
}

/** Parse a `/memorize <text>` command, or null if the input isn't one. */
export function parseMemorizeCommand(input: string): ParsedMemorizeCommand | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith(MEMORIZE_COMMAND_PREFIX)) return null
  const content = trimmed.slice(MEMORIZE_COMMAND_PREFIX.length).trim().slice(0, MEMORY_CONTENT_MAX_LEN)
  if (!content) return null

  const kind = inferKind(content)
  const result: ParsedMemorizeCommand = { content, kind }
  if (kind === 'preference') result.domain = inferPreferenceDomain(content)
  else if (kind === 'fact') result.factType = inferFactType(content)
  else if (kind === 'project') {
    const name = extractProjectName(content)
    if (name) result.projectName = name
  }
  return result
}

/** Build a persistable MemoryDoc from a parsed command (id/timestamps stamped by caller-provided now). */
export function buildExplicitMemoryDoc(parsed: ParsedMemorizeCommand, now: Date, id: string): MemoryDoc {
  const iso = now.toISOString()
  const doc: MemoryDoc = {
    id,
    kind: parsed.kind,
    content: parsed.content,
    weight: 1.0,
    sensitivity: 'low',
    status: 'active',
    createdAt: iso,
    lastUsedAt: iso,
    sources: ['explicit:/memorize'],
  }
  if (parsed.kind === 'preference') doc.preference = { domain: parsed.domain ?? 'general' }
  else if (parsed.kind === 'fact') doc.fact = { factType: parsed.factType ?? 'other' }
  else if (parsed.kind === 'project' && parsed.projectName) doc.project = { projectName: parsed.projectName }
  return doc
}

// ── Inference (ported verbatim from web) ────────────────────────────────────

const PREFERENCE_SIGNALS = [
  'prefer', 'like', 'love', 'hate', 'dislike', 'enjoy', 'want', 'favor',
  'style', 'tone', 'format', 'concise', 'brief', 'verbose', 'markdown',
  'always', 'never', 'avoid',
]
const FACT_SIGNALS = [
  'i am', 'my role', 'i work', 'my job', 'my name', 'i have', 'years',
  'expert', 'experience', 'background', 'i use', 'i specialize',
]
const PROJECT_SIGNALS = [
  'project', 'app', 'codebase', 'repository', 'product', 'startup',
  'client', 'application', 'service', 'system',
]

function inferKind(content: string): MemoryKind {
  const lower = content.toLowerCase()
  const factScore = FACT_SIGNALS.filter(s => lower.includes(s)).length
  const projectScore = PROJECT_SIGNALS.filter(s => lower.includes(s)).length
  const prefScore = PREFERENCE_SIGNALS.filter(s => lower.includes(s)).length
  if (factScore >= projectScore && factScore >= prefScore) return 'fact'
  if (projectScore > prefScore) return 'project'
  return 'preference'
}

function inferPreferenceDomain(content: string): string {
  const lower = content.toLowerCase()
  if (lower.match(/\b(svelte|react|vue|angular|next|framework|css|html)\b/)) return 'tech-stack'
  if (lower.match(/\b(code|comment|function|variable|naming|style)\b/)) return 'code-style'
  if (lower.match(/\b(tone|formal|casual|friendly|professional|concise|brief)\b/)) return 'communication-style'
  if (lower.match(/\b(tool|editor|vscode|vim|emacs|terminal|cli)\b/)) return 'tooling'
  return 'general'
}

function inferFactType(content: string): FactType {
  const lower = content.toLowerCase()
  if (lower.match(/\b(role|position|title|engineer|developer|designer|manager|pm)\b/)) return 'role'
  if (lower.match(/\b(expert|speciali|experience|years|proficient|skilled)\b/)) return 'expertise'
  if (lower.match(/\b(habit|routine|always|typically|usually|tend to)\b/)) return 'habit'
  if (lower.match(/\b(use|using|tool|editor|ide|stack|language)\b/)) return 'tool'
  return 'other'
}

function extractProjectName(content: string): string | null {
  const match = content.match(
    /(?:project|app|application|system|service)\s+(?:called\s+|named\s+)?["']?([A-Za-z][A-Za-z0-9_\-\s]{1,30})["']?/i,
  )
  return match?.[1]?.trim() ?? null
}
