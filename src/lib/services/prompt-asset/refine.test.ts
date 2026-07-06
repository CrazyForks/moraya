import { describe, it, expect } from 'vitest'
import { promptToTemplate, templateIdForPrompt, restoreTargetPath, PROMOTED_CATEGORY } from './refine'
import type { PromptAssetDoc } from './prompt-index'

function doc(over: Partial<PromptAssetDoc> = {}): PromptAssetDoc {
  return {
    relativePath: 'prompts/2026-07-04-fix-sync.md',
    title: '修复同步冲突',
    body: '修复 KB 同步冲突时末行换行丢失',
    meta: {
      source: 'claude-code',
      project: 'moraya',
      sessionId: 's',
      sentAt: '2026-07-04T00:00:00Z',
      tags: ['sync', 'bug'],
      usageCount: 2,
      lastUsedAt: '',
      contextFiles: [],
      contextNotes: '',
    },
    ...over,
  }
}

describe('templateIdForPrompt', () => {
  it('derives a stable id from the file stem', () => {
    expect(templateIdForPrompt('prompts/2026-07-04-fix-sync.md')).toBe(
      `${PROMOTED_CATEGORY}.2026-07-04-fix-sync`,
    )
  })
  it('handles a bare filename', () => {
    expect(templateIdForPrompt('x.md')).toBe(`${PROMOTED_CATEGORY}.x`)
  })
})

describe('restoreTargetPath', () => {
  it('moves an archived path back to prompts/', () => {
    expect(restoreTargetPath('prompts/archive/2026-07-04-x.md')).toBe('prompts/2026-07-04-x.md')
  })
  it('handles a bare filename', () => {
    expect(restoreTargetPath('x.md')).toBe('prompts/x.md')
  })
})

describe('promptToTemplate', () => {
  it('maps the prompt into a self-contained auto template', () => {
    const tpl = promptToTemplate(doc())
    expect(tpl.id).toBe(`${PROMOTED_CATEGORY}.2026-07-04-fix-sync`)
    expect(tpl.category).toBe(PROMOTED_CATEGORY)
    expect(tpl.name).toBe('修复同步冲突')
    expect(tpl.flow).toBe('auto')
    expect(tpl.contentSource).toBe('none')
    expect(tpl.systemPrompt).toBe('')
    expect(tpl.userPromptTemplate).toBe('修复 KB 同步冲突时末行换行丢失')
    expect(tpl.defaultActions).toEqual(['insert', 'copy'])
    expect(tpl.tags).toEqual(['sync', 'bug'])
  })
  it('carries the prompt body verbatim', () => {
    const body = 'line1\n\nline2 with  spaces'
    expect(promptToTemplate(doc({ body })).userPromptTemplate).toBe(body)
  })
})
