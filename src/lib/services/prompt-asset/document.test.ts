import { describe, it, expect } from 'vitest'
import {
  baseFileName,
  buildPromptMarkdown,
  dateStamp,
  slugify,
  uniqueFileName,
} from './document'
import type { PromptCandidate } from './types'

function cand(over: Partial<PromptCandidate> = {}): PromptCandidate {
  return {
    key: 'sess:abc',
    sessionId: 'sess-1',
    project: 'moraya',
    sentAt: '2026-07-04T11:14:13.453Z',
    text: '修复 KB 同步冲突时的末行换行问题',
    likely: true,
    ...over,
  }
}

describe('slugify', () => {
  it('preserves CJK and strips illegal chars', () => {
    expect(slugify('修复 KB 同步/冲突问题')).toBe('修复-kb-同步-冲突问题')
  })
  it('strips leading markdown markers', () => {
    expect(slugify('# 标题 heading')).toBe('标题-heading')
  })
  it('uses the first non-empty line', () => {
    expect(slugify('\n\n  实现功能\n第二行')).toBe('实现功能')
  })
  it('falls back to "prompt" for empty/symbol-only text', () => {
    expect(slugify('---')).toBe('prompt')
    expect(slugify('   ')).toBe('prompt')
  })
  it('caps length', () => {
    const long = 'a'.repeat(100)
    expect([...slugify(long)].length).toBeLessThanOrEqual(40)
  })
})

describe('dateStamp', () => {
  it('extracts YYYY-MM-DD from an ISO timestamp', () => {
    expect(dateStamp('2026-07-04T11:14:13.453Z')).toBe('2026-07-04')
  })
  it('returns a zero date for missing/invalid input', () => {
    expect(dateStamp('')).toBe('0000-00-00')
    expect(dateStamp('garbage')).toBe('0000-00-00')
  })
})

describe('baseFileName', () => {
  it('combines date and slug', () => {
    expect(baseFileName(cand())).toBe('2026-07-04-修复-kb-同步冲突时的末行换行问题.md')
  })
})

describe('uniqueFileName', () => {
  it('returns the base name when free', () => {
    const taken = new Set<string>()
    expect(uniqueFileName('a.md', taken)).toBe('a.md')
    expect(taken.has('a.md')).toBe(true)
  })
  it('appends an incrementing suffix on collision', () => {
    const taken = new Set(['a.md', 'a-2.md'])
    expect(uniqueFileName('a.md', taken)).toBe('a-3.md')
  })
})

describe('buildPromptMarkdown', () => {
  it('emits frontmatter + verbatim body', () => {
    const md = buildPromptMarkdown(cand())
    expect(md).toContain('---\n')
    expect(md).toContain('source: claude-code')
    expect(md).toContain('project: moraya')
    expect(md).toContain('sessionId: sess-1')
    expect(md).toContain('sentAt: "2026-07-04T11:14:13.453Z"')
    expect(md).toContain('tags: []')
    expect(md.trimEnd().endsWith('修复 KB 同步冲突时的末行换行问题')).toBe(true)
  })
  it('quotes project values with special characters', () => {
    const md = buildPromptMarkdown(cand({ project: 'my: proj "x"' }))
    expect(md).toContain('project: "my: proj \\"x\\""')
  })
  it('honors a custom source', () => {
    const md = buildPromptMarkdown(cand(), 'manual')
    expect(md).toContain('source: manual')
  })
  it('does not rewrite the prompt text', () => {
    const text = 'line1\n\n  line2 with  spaces'
    const md = buildPromptMarkdown(cand({ text }))
    expect(md).toContain(text.trim())
  })
})
