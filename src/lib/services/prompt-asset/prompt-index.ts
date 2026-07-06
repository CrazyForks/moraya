/**
 * Prompt-asset recall — pure indexing, ranking, and usage-bump logic.
 *
 * Operates on the Markdown documents written by the capture pillar
 * (docs/specs/prompt-asset.md §4.2). No Tauri/IPC here — the Tauri-facing
 * loader lives in `recall-service.ts`. All functions are unit-testable.
 */
import { extractFrontmatter } from '$lib/utils/frontmatter'

/** Parsed metadata from a prompt asset's frontmatter. Unknown fields are ignored. */
export interface PromptMeta {
  source: string
  project: string
  sessionId: string
  sentAt: string
  tags: string[]
  /** Times this prompt has been copied/inserted (frontmatter `usage-count`). */
  usageCount: number
  /** ISO timestamp of last use (frontmatter `last-used`), or '' if never. */
  lastUsedAt: string
  /** KB-relative paths bound as environment context (frontmatter `context-files`). */
  contextFiles: string[]
  /** Free-text background bundled with this prompt (frontmatter `context-notes`). */
  contextNotes: string
}

/** An indexed prompt asset ready for search + recall. */
export interface PromptAssetDoc {
  /** Path relative to KB root, e.g. "prompts/2026-07-04-fix-sync.md". */
  relativePath: string
  /** First non-empty body line, used as the display title. */
  title: string
  meta: PromptMeta
  /** Prompt text (frontmatter stripped). */
  body: string
}

/** Strip surrounding quotes from a YAML scalar. */
function unquote(v: string): string {
  const t = v.trim()
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return t
}

/** Parse an inline `[a, b]` YAML array, or return [] for `[]`/malformed. */
function parseInlineArray(v: string): string[] {
  const t = v.trim()
  if (!t.startsWith('[') || !t.endsWith(']')) return []
  const inner = t.slice(1, -1).trim()
  if (!inner) return []
  return inner
    .split(',')
    .map(s => unquote(s))
    .filter(Boolean)
}

/**
 * Parse the known frontmatter scalar/array fields from a prompt document.
 * Tolerant of a missing frontmatter block (returns defaults) and unknown keys.
 */
export function parsePromptMeta(frontmatterBlock: string): PromptMeta {
  const meta: PromptMeta = {
    source: '',
    project: '',
    sessionId: '',
    sentAt: '',
    tags: [],
    usageCount: 0,
    lastUsedAt: '',
    contextFiles: [],
    contextNotes: '',
  }
  for (const line of frontmatterBlock.split('\n')) {
    const m = line.match(/^([\w-]+):\s*(.*)$/)
    if (!m) continue
    const [, key, rawVal] = m
    const val = rawVal.trim()
    switch (key) {
      case 'source': meta.source = unquote(val); break
      case 'project': meta.project = unquote(val); break
      case 'sessionId': meta.sessionId = unquote(val); break
      case 'sentAt': meta.sentAt = unquote(val); break
      case 'tags': meta.tags = parseInlineArray(val); break
      case 'usage-count': meta.usageCount = Number.parseInt(unquote(val), 10) || 0; break
      case 'last-used': meta.lastUsedAt = unquote(val); break
      case 'context-files': meta.contextFiles = parseInlineArray(val); break
      case 'context-notes': meta.contextNotes = unquote(val); break
    }
  }
  return meta
}

/** First non-empty, marker-stripped body line — the recall display title. */
export function deriveTitle(body: string): string {
  const line = body.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''
  return line.replace(/^[#>\-*\s]+/, '').trim() || '(untitled prompt)'
}

/** Parse a full prompt-asset Markdown file into an indexed doc. */
export function parsePromptDoc(relativePath: string, content: string): PromptAssetDoc {
  const { frontmatter, body } = extractFrontmatter(content)
  return {
    relativePath,
    title: deriveTitle(body),
    meta: parsePromptMeta(frontmatter),
    body: body.trim(),
  }
}

/** Recency component: newer `lastUsedAt`/`sentAt` scores higher, bounded to [0, 5]. */
function recencyBoost(iso: string, nowMs: number): number {
  if (!iso) return 0
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 0
  const days = (nowMs - t) / 86_400_000
  if (days <= 1) return 5
  if (days <= 7) return 3
  if (days <= 30) return 1
  return 0
}

/**
 * Score a doc against a lower-cased query. Title matches weigh most, then
 * tags/project, then body; usage-count and recency break ties / rank the
 * empty-query list. Returns -1 when the query misses entirely.
 */
export function scoreDoc(doc: PromptAssetDoc, query: string, nowMs: number): number {
  const usageBoost = Math.min(doc.meta.usageCount, 10)
  const recency = Math.max(
    recencyBoost(doc.meta.lastUsedAt, nowMs),
    recencyBoost(doc.meta.sentAt, nowMs),
  )
  if (!query) return usageBoost + recency

  const q = query
  const title = doc.title.toLowerCase()
  const body = doc.body.toLowerCase()
  const project = doc.meta.project.toLowerCase()
  const tags = doc.meta.tags.join(' ').toLowerCase()

  let match = 0
  if (title.includes(q)) match += 100
  if (tags.includes(q)) match += 40
  if (project.includes(q)) match += 30
  if (body.includes(q)) match += 10
  if (match === 0) return -1
  return match + usageBoost + recency
}

/** Rank docs for a query, dropping misses. Stable, deterministic given `nowMs`. */
export function rankPrompts(
  docs: PromptAssetDoc[],
  query: string,
  nowMs: number,
): PromptAssetDoc[] {
  const q = query.trim().toLowerCase()
  const scored = docs
    .map(doc => ({ doc, score: scoreDoc(doc, q, nowMs) }))
    .filter(s => s.score >= 0)
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // Tie-break: more-recently-used first, then newer capture.
    const au = a.doc.meta.lastUsedAt || a.doc.meta.sentAt
    const bu = b.doc.meta.lastUsedAt || b.doc.meta.sentAt
    return bu.localeCompare(au)
  })
  return scored.map(s => s.doc)
}

/**
 * Return `content` with `usage-count` incremented and `last-used` set to
 * `nowIso`, editing only those two frontmatter lines (all other content and
 * formatting preserved). If there is no frontmatter block, `content` is
 * returned unchanged.
 */
export function bumpUsage(content: string, nowIso: string): string {
  const { frontmatter, body } = extractFrontmatter(content)
  if (!frontmatter) return content

  // frontmatter includes the fences: ---\n <lines> \n---\n
  const lines = frontmatter.split('\n')
  // Locate the closing fence (last '---' line).
  let closeIdx = -1
  for (let i = lines.length - 1; i >= 1; i--) {
    if (lines[i].trim() === '---') { closeIdx = i; break }
  }
  if (closeIdx < 0) return content

  const meta = parsePromptMeta(frontmatter)
  const nextCount = meta.usageCount + 1

  let sawCount = false
  let sawUsed = false
  for (let i = 1; i < closeIdx; i++) {
    if (/^usage-count:/.test(lines[i].trim())) { lines[i] = `usage-count: ${nextCount}`; sawCount = true }
    else if (/^last-used:/.test(lines[i].trim())) { lines[i] = `last-used: "${nowIso}"`; sawUsed = true }
  }
  const inserts: string[] = []
  if (!sawCount) inserts.push(`usage-count: ${nextCount}`)
  if (!sawUsed) inserts.push(`last-used: "${nowIso}"`)
  lines.splice(closeIdx, 0, ...inserts)

  return lines.join('\n') + body
}
