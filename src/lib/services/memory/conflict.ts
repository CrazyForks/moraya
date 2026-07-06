/**
 * Lightweight content-overlap scoring (ported from web `src/lib/memory/conflict.ts`),
 * used for near-duplicate detection in the health check.
 */
import type { MemoryDoc } from './types'

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'i', 'you',
  'my', 'your', 'to', 'of', 'in', 'on', 'for', 'with', 'at', 'by', 'it', 'this',
  'that', 'be', 'as', 'do', 'have', 'has',
])

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1 && !STOPWORDS.has(w)),
  )
}

/** Jaccard-style overlap coefficient in [0,1] over content-word sets. */
export function overlapScore(a: string, b: string): number {
  const sa = tokenize(a)
  const sb = tokenize(b)
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const w of sa) if (sb.has(w)) inter++
  return inter / Math.min(sa.size, sb.size)
}

/** Fast non-cryptographic content hash (DJB2) for exact-duplicate grouping. */
export function contentHash(content: string): string {
  let h = 5381
  for (let i = 0; i < content.length; i++) h = ((h << 5) + h + content.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

export function docTokens(doc: MemoryDoc): Set<string> {
  return tokenize(doc.content)
}
