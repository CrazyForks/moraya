/**
 * Prompt-asset dedup — deterministic near-duplicate detection over prompt
 * bodies (no LLM). Reuses the memory service's token-overlap coefficient.
 * See docs/specs/prompt-asset.md §4.3 ("AI 去重/合并" — the detection half,
 * done deterministically; merge = keep one + archive the rest).
 */
import { overlapScore } from '$lib/services/memory/conflict'
import type { PromptAssetDoc } from './prompt-index'

/** Default overlap coefficient above which two prompts are "near-duplicates". */
export const DEFAULT_DUP_THRESHOLD = 0.8

/**
 * Cluster prompts into near-duplicate groups by transitive body similarity.
 * Only groups with ≥2 members are returned. Within each group the best
 * "keep" candidate — most-used, then most-recent — comes first. Group order is
 * stable (by the first member's path).
 */
export function findDuplicateGroups(
  docs: PromptAssetDoc[],
  threshold: number = DEFAULT_DUP_THRESHOLD,
): PromptAssetDoc[][] {
  const n = docs.length
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (overlapScore(docs[i].body, docs[j].body) >= threshold) {
        parent[find(i)] = find(j)
      }
    }
  }

  const clusters = new Map<number, PromptAssetDoc[]>()
  for (let i = 0; i < n; i++) {
    const root = find(i)
    const g = clusters.get(root) ?? []
    g.push(docs[i])
    clusters.set(root, g)
  }

  const groups: PromptAssetDoc[][] = []
  for (const g of clusters.values()) {
    if (g.length < 2) continue
    g.sort((a, b) => {
      if (b.meta.usageCount !== a.meta.usageCount) return b.meta.usageCount - a.meta.usageCount
      const au = a.meta.lastUsedAt || a.meta.sentAt
      const bu = b.meta.lastUsedAt || b.meta.sentAt
      return bu.localeCompare(au)
    })
    groups.push(g)
  }
  groups.sort((a, b) => a[0].relativePath.localeCompare(b[0].relativePath))
  return groups
}

/** Set of relativePaths that participate in any duplicate group. */
export function duplicatePaths(groups: PromptAssetDoc[][]): Set<string> {
  const s = new Set<string>()
  for (const g of groups) for (const d of g) s.add(d.relativePath)
  return s
}

/** The duplicate group containing `relativePath`, or null. */
export function groupFor(
  groups: PromptAssetDoc[][],
  relativePath: string,
): PromptAssetDoc[] | null {
  return groups.find(g => g.some(d => d.relativePath === relativePath)) ?? null
}
