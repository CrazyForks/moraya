import { describe, it, expect } from 'vitest'
import {
  addContextFileToFrontmatter,
  assemblePromptCard,
  removeContextFileFromFrontmatter,
} from './prompt-card'
import { parsePromptDoc } from './prompt-index'

const LABELS = { background: 'Background', contextFile: 'Context file' }

describe('assemblePromptCard', () => {
  it('assembles notes, files, and body separated by rules', () => {
    const out = assemblePromptCard(
      {
        body: '修复同步冲突',
        notes: '这是 Tauri v2 项目',
        files: [{ path: 'docs/arch.md', content: 'architecture' }],
      },
      LABELS,
    )
    expect(out).toBe(
      '## Background\n\n这是 Tauri v2 项目\n\n---\n\n' +
        '## Context file: docs/arch.md\n\narchitecture\n\n---\n\n' +
        '修复同步冲突\n',
    )
  })
  it('omits empty sections', () => {
    const out = assemblePromptCard({ body: 'do it', notes: '', files: [] }, LABELS)
    expect(out).toBe('do it\n')
  })
  it('inlines multiple files in order', () => {
    const out = assemblePromptCard(
      {
        body: 'B',
        notes: '',
        files: [
          { path: 'a.md', content: 'AA' },
          { path: 'b.md', content: 'BB' },
        ],
      },
      LABELS,
    )
    const idxA = out.indexOf('a.md')
    const idxB = out.indexOf('b.md')
    expect(idxA).toBeGreaterThan(-1)
    expect(idxB).toBeGreaterThan(idxA)
  })
  it('uses localized labels', () => {
    const out = assemblePromptCard(
      { body: 'x', notes: 'n', files: [{ path: 'f', content: 'c' }] },
      { background: '背景', contextFile: '上下文文件' },
    )
    expect(out).toContain('## 背景')
    expect(out).toContain('## 上下文文件: f')
  })
})

const DOC = `---
source: claude-code
project: moraya
sessionId: s
sentAt: "2026-07-04T00:00:00Z"
tags: []
---

修复问题`

describe('parse context frontmatter', () => {
  it('reads context-files and context-notes', () => {
    const withCtx = `---
source: claude-code
project: moraya
sessionId: s
sentAt: "2026-07-04T00:00:00Z"
context-files: ["docs/a.md", "src/b.ts"]
context-notes: "背景说明"
---

body`
    const doc = parsePromptDoc('p.md', withCtx)
    expect(doc.meta.contextFiles).toEqual(['docs/a.md', 'src/b.ts'])
    expect(doc.meta.contextNotes).toBe('背景说明')
  })
  it('defaults to empty when absent', () => {
    const doc = parsePromptDoc('p.md', DOC)
    expect(doc.meta.contextFiles).toEqual([])
    expect(doc.meta.contextNotes).toBe('')
  })
})

describe('addContextFileToFrontmatter', () => {
  it('creates the context-files line when absent', () => {
    const out = addContextFileToFrontmatter(DOC, 'docs/arch.md')
    expect(parsePromptDoc('p.md', out).meta.contextFiles).toEqual(['docs/arch.md'])
    // body preserved
    expect(out).toContain('修复问题')
  })
  it('appends to an existing list and dedupes', () => {
    const once = addContextFileToFrontmatter(DOC, 'a.md')
    const twice = addContextFileToFrontmatter(once, 'b.md')
    expect(parsePromptDoc('p.md', twice).meta.contextFiles).toEqual(['a.md', 'b.md'])
    const dup = addContextFileToFrontmatter(twice, 'a.md')
    expect(dup).toBe(twice) // no-op, unchanged
  })
  it('no-ops without frontmatter', () => {
    expect(addContextFileToFrontmatter('plain', 'x.md')).toBe('plain')
  })
  it('quotes paths with spaces/special chars', () => {
    const out = addContextFileToFrontmatter(DOC, 'my docs/a b.md')
    expect(out).toContain('context-files: ["my docs/a b.md"]')
  })
})

describe('removeContextFileFromFrontmatter', () => {
  it('removes a bound path', () => {
    const bound = addContextFileToFrontmatter(DOC, 'a.md')
    const out = removeContextFileFromFrontmatter(bound, 'a.md')
    expect(parsePromptDoc('p.md', out).meta.contextFiles).toEqual([])
  })
  it('no-ops when the path is not bound', () => {
    expect(removeContextFileFromFrontmatter(DOC, 'zzz')).toBe(DOC)
  })
})
