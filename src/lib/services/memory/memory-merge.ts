/**
 * Cross-machine memory-file merge (Picora 设计 §6).
 *
 * When machine B pulls a file that already exists locally with different
 * content, we auto-merge instead of skipping (old behavior) or overwriting:
 *   - Index/append files (MEMORY.md, index.json)   → row-set UNION merge
 *     (both machines append lines; union+dedupe avoids互吞行).
 *   - Everything else (e.g. CLAUDE.md)              → line-level merge via the
 *     shared kb-sync engine (auto-merges non-overlapping edits; true overlaps
 *     stay a conflict → caller keeps both, non-destructive).
 *
 * NOTE: reuses `../kb-sync/merge` (the KB-sync Git-style merge engine). That
 * module currently lives in the maintainer's in-flight KB-sync work; this file
 * depends on it landing.
 */
import { twoWayMergeLines } from '../kb-sync/merge'

/** Append/index-style memory files that merge by line-set union. */
export function isIndexFile(rel: string): boolean {
  const base = rel.split('/').pop() ?? rel
  return /^MEMORY\.md$/i.test(base) || /(^|-)index\.json$/i.test(base)
}

/**
 * Union merge: keep all local lines, then append remote lines whose trimmed
 * form isn't already present locally. Order-preserving, dedup by trimmed text.
 */
export function unionMergeLines(local: string, remote: string): string {
  const localLines = local.split(/\r?\n/)
  const seen = new Set(localLines.map(l => l.trim()).filter(Boolean))
  const extra = remote.split(/\r?\n/).filter(l => {
    const t = l.trim()
    return t !== '' && !seen.has(t)
  })
  if (extra.length === 0) return local
  const trimmedTail = local.replace(/\s*$/, '')
  return `${trimmedTail}\n${extra.join('\n')}\n`
}

export interface MemoryMergeOutcome {
  /** Merged content when resolvable; null on an unresolved (overlapping) conflict. */
  merged: string | null
  conflict: boolean
}

/** Merge a local + remote version of a memory file at `rel`. */
export function mergeMemoryFile(rel: string, local: string, remote: string): MemoryMergeOutcome {
  if (local === remote) return { merged: local, conflict: false }
  if (isIndexFile(rel)) return { merged: unionMergeLines(local, remote), conflict: false }
  const r = twoWayMergeLines(local, remote)
  if (!r.hasConflict && r.mergedText != null) return { merged: r.mergedText, conflict: false }
  return { merged: null, conflict: true }
}
