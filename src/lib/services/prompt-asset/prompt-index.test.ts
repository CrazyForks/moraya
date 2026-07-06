import { describe, it, expect } from 'vitest'
import {
  bumpUsage,
  deriveTitle,
  parsePromptDoc,
  parsePromptMeta,
  rankPrompts,
  scoreDoc,
  type PromptAssetDoc,
} from './prompt-index'

const FILE = `---
source: claude-code
project: moraya
sessionId: sess-1
sentAt: "2026-07-04T11:14:13.453Z"
tags: [sync, bug]
usage-count: 3
last-used: "2026-07-05T09:00:00.000Z"
---

修复 KB 同步冲突时末行换行丢失的问题
第二行细节`

describe('parsePromptMeta', () => {
  it('reads all known fields', () => {
    const { frontmatter } = { frontmatter: FILE.slice(0, FILE.indexOf('---', 3) + 4) }
    const meta = parsePromptMeta(frontmatter)
    expect(meta.source).toBe('claude-code')
    expect(meta.project).toBe('moraya')
    expect(meta.sessionId).toBe('sess-1')
    expect(meta.sentAt).toBe('2026-07-04T11:14:13.453Z')
    expect(meta.tags).toEqual(['sync', 'bug'])
    expect(meta.usageCount).toBe(3)
    expect(meta.lastUsedAt).toBe('2026-07-05T09:00:00.000Z')
  })
  it('defaults gracefully with no fields', () => {
    const meta = parsePromptMeta('')
    expect(meta.usageCount).toBe(0)
    expect(meta.tags).toEqual([])
  })
})

describe('deriveTitle', () => {
  it('uses the first non-empty marker-stripped line', () => {
    expect(deriveTitle('\n\n# Hello world\nmore')).toBe('Hello world')
  })
  it('falls back for empty body', () => {
    expect(deriveTitle('   ')).toBe('(untitled prompt)')
  })
})

describe('parsePromptDoc', () => {
  it('splits frontmatter from body and derives a title', () => {
    const doc = parsePromptDoc('prompts/x.md', FILE)
    expect(doc.relativePath).toBe('prompts/x.md')
    expect(doc.title).toBe('修复 KB 同步冲突时末行换行丢失的问题')
    expect(doc.meta.usageCount).toBe(3)
    expect(doc.body.startsWith('修复 KB')).toBe(true)
  })
})

function mkDoc(over: Partial<PromptAssetDoc> & { title: string }): PromptAssetDoc {
  return {
    relativePath: `prompts/${over.title}.md`,
    title: over.title,
    body: over.body ?? '',
    meta: {
      source: 'claude-code',
      project: over.meta?.project ?? 'p',
      sessionId: 's',
      sentAt: over.meta?.sentAt ?? '2026-01-01T00:00:00Z',
      tags: over.meta?.tags ?? [],
      usageCount: over.meta?.usageCount ?? 0,
      lastUsedAt: over.meta?.lastUsedAt ?? '',
    },
  }
}

describe('scoreDoc', () => {
  const now = Date.parse('2026-07-06T00:00:00Z')
  it('returns -1 on a miss', () => {
    expect(scoreDoc(mkDoc({ title: 'alpha' }), 'zzz', now)).toBe(-1)
  })
  it('weighs title over body', () => {
    const titleHit = scoreDoc(mkDoc({ title: 'sync fix' }), 'sync', now)
    const bodyHit = scoreDoc(mkDoc({ title: 'x', body: 'sync' }), 'sync', now)
    expect(titleHit).toBeGreaterThan(bodyHit)
  })
  it('ranks empty query by usage + recency', () => {
    const hot = scoreDoc(mkDoc({ title: 'a', meta: { usageCount: 8 } as never }), '', now)
    const cold = scoreDoc(mkDoc({ title: 'b' }), '', now)
    expect(hot).toBeGreaterThan(cold)
  })
})

describe('rankPrompts', () => {
  const now = Date.parse('2026-07-06T00:00:00Z')
  it('orders matches by score and drops misses', () => {
    const docs = [
      mkDoc({ title: 'unrelated' }),
      mkDoc({ title: 'sync helper' }),
      mkDoc({ title: 'x', body: 'about sync internals' }),
    ]
    const ranked = rankPrompts(docs, 'sync', now)
    expect(ranked.map(d => d.title)).toEqual(['sync helper', 'x'])
  })
  it('empty query returns all, most-used first', () => {
    const docs = [
      mkDoc({ title: 'low', meta: { usageCount: 1 } as never }),
      mkDoc({ title: 'high', meta: { usageCount: 9 } as never }),
    ]
    expect(rankPrompts(docs, '', now).map(d => d.title)).toEqual(['high', 'low'])
  })
})

describe('bumpUsage', () => {
  it('increments usage-count and updates last-used in place', () => {
    const out = bumpUsage(FILE, '2026-07-06T12:00:00.000Z')
    const meta = parsePromptDoc('x', out).meta
    expect(meta.usageCount).toBe(4)
    expect(meta.lastUsedAt).toBe('2026-07-06T12:00:00.000Z')
    // Body preserved verbatim.
    expect(out).toContain('修复 KB 同步冲突时末行换行丢失的问题')
    expect(out).toContain('第二行细节')
  })
  it('inserts usage fields when absent', () => {
    const minimal = `---\nsource: manual\nproject: p\n---\n\nhello`
    const out = bumpUsage(minimal, '2026-07-06T00:00:00Z')
    const meta = parsePromptMeta(out.slice(0, out.lastIndexOf('---') + 3))
    expect(meta.usageCount).toBe(1)
    expect(meta.lastUsedAt).toBe('2026-07-06T00:00:00Z')
  })
  it('returns content unchanged with no frontmatter', () => {
    expect(bumpUsage('just text', '2026-07-06T00:00:00Z')).toBe('just text')
  })
})
