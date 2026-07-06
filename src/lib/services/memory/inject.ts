/**
 * Memory ranking + system-prompt injection for PC.
 *
 * PC has no local embeddings, so relevance is decay-weight + query substring
 * overlap (vs web's cosine similarity). The injected fragment matches web's
 * format so the model sees a consistent shape across platforms.
 */
import type { MemoryDoc, MemoryHalfLife } from './types'
import { INJECT_TOP_K, INJECT_TOKEN_LIMIT } from './types'
import { effectiveWeight } from './decay'
import { tokenize } from './conflict'

export interface RankedMemory {
  doc: MemoryDoc
  score: number
}

/**
 * Rank active memories by effectiveWeight plus query relevance (fraction of
 * query terms present in the memory content). Query may be empty → weight only.
 */
export function rankMemories(
  docs: MemoryDoc[],
  query: string,
  now: Date,
  halfLife: MemoryHalfLife = 90,
): RankedMemory[] {
  const qTerms = tokenize(query)
  return docs
    .filter(d => d.status === 'active')
    .map(doc => {
      const base = effectiveWeight(doc, now, halfLife)
      let relevance = 0
      if (qTerms.size > 0) {
        const content = doc.content.toLowerCase()
        let hits = 0
        for (const term of qTerms) if (content.includes(term)) hits++
        relevance = hits / qTerms.size
      }
      return { doc, score: base + relevance }
    })
    .sort((a, b) => b.score - a.score)
}

/** Select top-K within a rough token budget (~content.length/4 tokens each). */
export function selectTopK(
  ranked: RankedMemory[],
  topK = INJECT_TOP_K,
  tokenLimit = INJECT_TOKEN_LIMIT,
): RankedMemory[] {
  const selected: RankedMemory[] = []
  let tokens = 0
  for (const r of ranked.slice(0, topK)) {
    const est = Math.ceil(r.doc.content.length / 4)
    if (tokens + est > tokenLimit) break
    selected.push(r)
    tokens += est
  }
  return selected
}

export function formatInjection(selected: RankedMemory[]): string {
  if (selected.length === 0) return ''
  const lines = selected.map(({ doc, score }) => {
    const label = doc.kind === 'preference' ? '[Preference]' : doc.kind === 'project' ? '[Project]' : '[Fact]'
    return `${label} ${doc.content} (relevance: ${score.toFixed(2)})`
  })
  return ['User long-term memories (sorted by relevance):', ...lines].join('\n')
}

export interface MemoryInjection {
  fragment: string
  usedMemoryIds: string[]
}

/** Full pipeline: rank → select → format. Empty fragment when nothing selected. */
export function buildInjection(
  docs: MemoryDoc[],
  query: string,
  now: Date,
  halfLife: MemoryHalfLife = 90,
): MemoryInjection {
  const selected = selectTopK(rankMemories(docs, query, now, halfLife))
  return { fragment: formatInjection(selected), usedMemoryIds: selected.map(r => r.doc.id) }
}
