import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { MemoryDoc } from './types'
import { effectiveWeight, isStale } from './decay'
import { parseMemorizeCommand, buildExplicitMemoryDoc } from './explicit'
import { overlapScore, contentHash } from './conflict'
import { rankMemories, buildInjection } from './inject'
import { runHealthCheck } from './health'
import * as store from './store'
import { memorizeFromInput, buildChatMemoryContext, writeMemory, deleteMemory, resetAllMemories, _setCloudPushEnabled } from './runtime'

function makeDoc(overrides: Partial<MemoryDoc> = {}): MemoryDoc {
  const iso = '2026-07-06T00:00:00.000Z'
  return {
    id: 'm1', kind: 'preference', content: 'I prefer concise answers',
    weight: 1, sensitivity: 'low', status: 'active',
    createdAt: iso, lastUsedAt: iso, sources: [], ...overrides,
  }
}

// ── decay ──────────────────────────────────────────────────────────────────

describe('effectiveWeight', () => {
  it('returns capped weight for fixedWeight docs', () => {
    const doc = makeDoc({ fixedWeight: true, weight: 2 })
    expect(effectiveWeight(doc, new Date('2030-01-01'))).toBe(1)
  })
  it('does not decay when halfLife is never', () => {
    const doc = makeDoc({ createdAt: '2020-01-01T00:00:00.000Z', lastUsedAt: '2020-01-01T00:00:00.000Z', weight: 0.8 })
    // old lastUsed → stale boost 1.0; never → decay 1.0 → 0.8
    expect(effectiveWeight(doc, new Date('2026-01-01'), 'never')).toBeCloseTo(0.8, 5)
  })
  it('decays with age under a finite half-life', () => {
    const created = '2026-01-01T00:00:00.000Z'
    const now = new Date('2026-04-01T00:00:00.000Z') // ~90 days
    const doc = makeDoc({ createdAt: created, lastUsedAt: created, weight: 1 })
    const w = effectiveWeight(doc, now, 90)
    expect(w).toBeGreaterThan(0.4)
    expect(w).toBeLessThan(0.6) // ~0.5 half-life, stale boost 1.0
  })
  it('flags stale below threshold', () => {
    const doc = makeDoc({ createdAt: '2020-01-01T00:00:00.000Z', lastUsedAt: '2020-01-01T00:00:00.000Z', weight: 0.5 })
    expect(isStale(doc, new Date('2026-01-01'), 30)).toBe(true)
  })
})

// ── explicit ────────────────────────────────────────────────────────────────

describe('parseMemorizeCommand', () => {
  it('returns null for non-memorize input', () => {
    expect(parseMemorizeCommand('hello')).toBeNull()
    expect(parseMemorizeCommand('/memorize   ')).toBeNull()
  })
  it('parses content and infers a preference kind', () => {
    const p = parseMemorizeCommand('/memorize I prefer concise, brief answers')
    expect(p?.content).toBe('I prefer concise, brief answers')
    expect(p?.kind).toBe('preference')
  })
  it('infers fact kind from self-description', () => {
    expect(parseMemorizeCommand('/memorize I am a senior engineer')?.kind).toBe('fact')
  })
  it('truncates to 200 chars', () => {
    const p = parseMemorizeCommand('/memorize ' + 'x'.repeat(300))
    expect(p?.content).toHaveLength(200)
  })
  it('builds a MemoryDoc with stamped fields', () => {
    const p = parseMemorizeCommand('/memorize I love TypeScript')!
    const doc = buildExplicitMemoryDoc(p, new Date('2026-07-06T00:00:00.000Z'), 'id-1')
    expect(doc).toMatchObject({ id: 'id-1', status: 'active', weight: 1, sources: ['explicit:/memorize'] })
    expect(doc.createdAt).toBe('2026-07-06T00:00:00.000Z')
  })
})

// ── conflict ────────────────────────────────────────────────────────────────

describe('overlapScore / contentHash', () => {
  it('scores identical content as 1', () => {
    expect(overlapScore('I prefer dark mode themes', 'I prefer dark mode themes')).toBe(1)
  })
  it('scores disjoint content as 0', () => {
    expect(overlapScore('coffee beans', 'quantum physics')).toBe(0)
  })
  it('hashes identical content equally, different content differently', () => {
    expect(contentHash('abc')).toBe(contentHash('abc'))
    expect(contentHash('abc')).not.toBe(contentHash('abd'))
  })
})

// ── inject ──────────────────────────────────────────────────────────────────

describe('rankMemories / buildInjection', () => {
  it('excludes deleted memories', () => {
    const docs = [makeDoc({ id: 'a' }), makeDoc({ id: 'b', status: 'deleted' })]
    const ranked = rankMemories(docs, '', new Date('2026-07-06'), 90)
    expect(ranked.map(r => r.doc.id)).toEqual(['a'])
  })
  it('boosts query-matching memories', () => {
    const docs = [
      makeDoc({ id: 'match', content: 'I love TypeScript strict mode' }),
      makeDoc({ id: 'other', content: 'coffee before noon' }),
    ]
    const ranked = rankMemories(docs, 'typescript', new Date('2026-07-06'), 90)
    expect(ranked[0].doc.id).toBe('match')
  })
  it('formats an injection fragment with kind labels', () => {
    const { fragment, usedMemoryIds } = buildInjection([makeDoc({ content: 'be concise' })], 'q', new Date('2026-07-06'), 90)
    expect(fragment).toContain('[Preference]')
    expect(fragment).toContain('be concise')
    expect(usedMemoryIds).toHaveLength(1)
  })
  it('returns empty fragment for no memories', () => {
    expect(buildInjection([], 'q', new Date(), 90).fragment).toBe('')
  })
})

// ── health ──────────────────────────────────────────────────────────────────

describe('runHealthCheck', () => {
  it('reports capacity with structured params (no baked-in English)', () => {
    const docs = Array.from({ length: 800 }, (_, i) => makeDoc({ id: `m${i}`, content: `unique content ${i}` }))
    const report = runHealthCheck(docs)
    const cap = report.issues.find(i => i.type === 'capacity')
    expect(cap?.params).toEqual({ pct: 80, active: 800, max: 1000 })
    for (const issue of report.issues) expect(issue).not.toHaveProperty('message')
  })
  it('detects duplicates', () => {
    const c = 'exactly the same memory content here'
    const report = runHealthCheck([makeDoc({ id: 'a', content: c }), makeDoc({ id: 'b', content: c })])
    expect(report.issues.some(i => i.type === 'duplicate')).toBe(true)
  })
})

// ── store + runtime (in-memory persistence) ─────────────────────────────────

describe('store + runtime', () => {
  const disk = new Map<string, unknown>()
  beforeEach(() => {
    disk.clear()
    store.setMemoryPersistence({
      async read<T>(k: string) { return (disk.has(k) ? (disk.get(k) as T) : null) },
      async write(k: string, v: unknown) { disk.set(k, v) },
    })
    store._resetCache()
    _setCloudPushEnabled(false) // no cloud side effects in tests
  })
  afterEach(() => {
    store.setMemoryPersistence(null)
    _setCloudPushEnabled(true)
  })

  it('memorizeFromInput persists an active memory', async () => {
    const doc = await memorizeFromInput('/memorize I prefer concise answers')
    expect(doc).not.toBeNull()
    expect(await store.count(true)).toBe(1)
    expect((await store.getAll())[0].content).toBe('I prefer concise answers')
  })

  it('memorizeFromInput returns null for non-command', async () => {
    expect(await memorizeFromInput('just chatting')).toBeNull()
    expect(await store.count(true)).toBe(0)
  })

  it('buildChatMemoryContext injects stored memories', async () => {
    await writeMemory({ content: 'Uses Svelte 5', kind: 'fact' })
    const frag = await buildChatMemoryContext('svelte question')
    expect(frag).toContain('Uses Svelte 5')
  })

  it('buildChatMemoryContext returns empty when store is empty', async () => {
    expect(await buildChatMemoryContext('anything')).toBe('')
  })

  it('deleteMemory soft-deletes (excluded from active)', async () => {
    const d = await writeMemory({ content: 'temp', kind: 'preference' })
    await deleteMemory(d.id)
    expect(await store.count()).toBe(0)
    expect(await store.count(true)).toBe(1)
  })

  it('resetAllMemories hard-deletes everything', async () => {
    await writeMemory({ content: 'a', kind: 'fact' })
    await writeMemory({ content: 'b', kind: 'fact' })
    await resetAllMemories()
    expect(await store.count(true)).toBe(0)
  })

  it('half-life setting round-trips with a default', async () => {
    expect(await store.getHalfLife()).toBe(90)
    await store.setHalfLife('never')
    expect(await store.getHalfLife()).toBe('never')
  })

  it('cloud config round-trips (KB auto-discovered, not stored)', async () => {
    expect(await store.getCloudConfig()).toEqual({ enabled: false, targetId: null })
    await store.setCloudConfig({ enabled: true, targetId: 't1' })
    expect(await store.getCloudConfig()).toEqual({ enabled: true, targetId: 't1' })
  })
})
