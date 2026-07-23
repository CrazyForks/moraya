import { describe, it, expect } from 'vitest'
import { findDuplicateGroups, duplicatePaths, groupFor } from './dedup'
import type { PromptAssetDoc } from './prompt-index'

function doc(path: string, body: string, over: Partial<PromptAssetDoc['meta']> = {}): PromptAssetDoc {
  return {
    relativePath: path,
    title: body.slice(0, 10),
    body,
    meta: {
      source: 'claude-code',
      project: 'p',
      sessionId: 's',
      sentAt: '2026-07-01T00:00:00Z',
      tags: [],
      usageCount: 0,
      lastUsedAt: '',
      contextFiles: [],
      contextNotes: '',
      ...over,
    },
  }
}

describe('findDuplicateGroups', () => {
  it('groups near-identical prompts and ignores distinct ones', () => {
    const docs = [
      doc('a.md', 'implement the knowledge base sync conflict resolver feature'),
      doc('b.md', 'implement the knowledge base sync conflict resolver feature please'),
      doc('c.md', 'generate a poem about the autumn moon and rivers'),
    ]
    const groups = findDuplicateGroups(docs)
    expect(groups).toHaveLength(1)
    expect(groups[0].map(d => d.relativePath).sort()).toEqual(['a.md', 'b.md'])
  })

  it('returns no groups when everything is distinct', () => {
    const docs = [
      doc('a.md', 'translate this document into french'),
      doc('b.md', 'summarize the quarterly financial report'),
    ]
    expect(findDuplicateGroups(docs)).toHaveLength(0)
  })

  it('orders each group with the best keep-candidate first (usage then recency)', () => {
    const body = 'refactor the authentication module to use tokens'
    const docs = [
      doc('low.md', body, { usageCount: 1 }),
      doc('high.md', body + ' now', { usageCount: 9 }),
    ]
    const groups = findDuplicateGroups(docs)
    expect(groups[0][0].relativePath).toBe('high.md')
  })

  it('clusters transitively (a~b, b~c ⇒ one group)', () => {
    const docs = [
      doc('a.md', 'write unit tests for the parser module thoroughly'),
      doc('b.md', 'write unit tests for the parser module thoroughly now'),
      doc('c.md', 'write unit tests for the parser module thoroughly today'),
    ]
    const groups = findDuplicateGroups(docs)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toHaveLength(3)
  })
})

describe('duplicatePaths', () => {
  it('collects all paths in any group', () => {
    const docs = [
      doc('a.md', 'fix the flaky integration test in the ci pipeline'),
      doc('b.md', 'fix the flaky integration test in the ci pipeline again'),
      doc('c.md', 'draft a product launch announcement email'),
    ]
    const paths = duplicatePaths(findDuplicateGroups(docs))
    expect(paths.has('a.md')).toBe(true)
    expect(paths.has('b.md')).toBe(true)
    expect(paths.has('c.md')).toBe(false)
  })
})

describe('groupFor', () => {
  it('finds the group containing a path, or null', () => {
    const docs = [
      doc('a.md', 'optimize the database query for the dashboard view'),
      doc('b.md', 'optimize the database query for the dashboard view fast'),
    ]
    const groups = findDuplicateGroups(docs)
    expect(groupFor(groups, 'a.md')).not.toBeNull()
    expect(groupFor(groups, 'zzz.md')).toBeNull()
  })
})
