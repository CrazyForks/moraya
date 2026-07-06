import { describe, it, expect } from 'vitest'
import {
  classify,
  dedupe,
  deriveProject,
  extractCandidates,
  hashText,
  isLikelyPrompt,
  normalizeText,
} from './transcript'

/** Helper to build one JSONL line matching Claude Code's transcript shape. */
function userLine(
  content: unknown,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
    sessionId: 'sess-1',
    cwd: '/Users/me/Documents/farmai',
    timestamp: '2026-07-04T11:14:13.453Z',
    ...extra,
  })
}

describe('normalizeText', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeText('  a\n\n  b   c ')).toBe('a b c')
  })
})

describe('hashText', () => {
  it('is stable and differs for different input', () => {
    expect(hashText('hello')).toBe(hashText('hello'))
    expect(hashText('hello')).not.toBe(hashText('world'))
  })
})

describe('deriveProject', () => {
  it('uses cwd basename when present', () => {
    expect(deriveProject('/Users/me/Documents/farmai', '-x-y')).toBe('farmai')
  })
  it('falls back to last segment of encoded dir name', () => {
    expect(deriveProject(null, '-Users-me-Documents-app')).toBe('app')
  })
  it('handles trailing slash in cwd', () => {
    expect(deriveProject('/Users/me/proj/', 'dir')).toBe('proj')
  })
})

describe('classify', () => {
  it('keeps a genuine prompt', () => {
    expect(classify('修复同步冲突丢失末行换行的问题', {})).toBeNull()
  })
  it('drops meta messages', () => {
    expect(classify('[Image: 1206x2622]', { isMeta: true })).toBe('meta')
  })
  it('drops sidechain (sub-agent) turns', () => {
    expect(classify('search the codebase', { isSidechain: true })).toBe('sidechain')
  })
  it('drops empty text', () => {
    expect(classify('   ', {})).toBe('empty')
  })
  it('drops system-injected task notifications', () => {
    expect(classify('<task-notification>\n<task-id>abc</task-id>', {})).toBe('system-tag')
  })
  it('drops system reminders', () => {
    expect(classify('<system-reminder>do the thing</system-reminder>', {})).toBe('system-tag')
  })
  it('drops interrupted-request markers', () => {
    expect(classify('[Request interrupted by user]', {})).toBe('system-tag')
  })
  it('drops slash-command echoes anywhere in the text', () => {
    expect(classify('<command-name>/model</command-name>', {})).toBe('slash-command')
    expect(classify('foo <local-command-stdout>bar</local-command-stdout>', {})).toBe('slash-command')
  })
})

describe('isLikelyPrompt', () => {
  it('flags long messages as likely', () => {
    expect(isLikelyPrompt('请帮我实现提示词资产捕获功能')).toBe(true)
  })
  it('rejects short confirmations regardless of length rule', () => {
    expect(isLikelyPrompt('继续')).toBe(false)
    expect(isLikelyPrompt('  OK ')).toBe(false)
    expect(isLikelyPrompt('yes')).toBe(false)
  })
  it('rejects very short non-confirmations by length', () => {
    expect(isLikelyPrompt('hi there')).toBe(false)
  })
})

describe('extractCandidates', () => {
  const ctx = { sessionId: 'file-stem', dirName: '-Users-me-Documents-farmai' }

  it('extracts a string-content user prompt', () => {
    const jsonl = userLine('启动app模拟器调试app')
    const out = extractCandidates(jsonl, ctx)
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe('启动app模拟器调试app')
    expect(out[0].project).toBe('farmai')
    expect(out[0].sessionId).toBe('sess-1')
    expect(out[0].sentAt).toBe('2026-07-04T11:14:13.453Z')
  })

  it('extracts text blocks from an array content', () => {
    const jsonl = userLine([{ type: 'text', text: '实现功能 A' }])
    const out = extractCandidates(jsonl, ctx)
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe('实现功能 A')
  })

  it('skips tool_result user turns', () => {
    const jsonl = userLine([{ type: 'tool_result', content: 'stdout…' }])
    expect(extractCandidates(jsonl, ctx)).toHaveLength(0)
  })

  it('skips meta, sidechain, system tags and slash commands', () => {
    const lines = [
      userLine('[Image: x]', { isMeta: true }),
      userLine('内部检索', { isSidechain: true }),
      userLine('<task-notification>\nx'),
      userLine('<command-name>/model</command-name>'),
      userLine('修复真实的需求问题描述文本'),
    ].join('\n')
    const out = extractCandidates(lines, ctx)
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe('修复真实的需求问题描述文本')
  })

  it('skips malformed JSON lines and blank lines', () => {
    const jsonl = ['not json', '', userLine('真实需求提示词内容文本')].join('\n')
    expect(extractCandidates(jsonl, ctx)).toHaveLength(1)
  })

  it('falls back to ctx.sessionId when the entry lacks one', () => {
    const jsonl = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: '一个足够长的需求提示词文本' },
      timestamp: '2026-07-04T00:00:00Z',
    })
    const out = extractCandidates(jsonl, ctx)
    expect(out[0].sessionId).toBe('file-stem')
  })

  it('marks short confirmations as unlikely but still returns them', () => {
    const jsonl = userLine('继续')
    const out = extractCandidates(jsonl, ctx)
    expect(out).toHaveLength(1)
    expect(out[0].likely).toBe(false)
  })
})

describe('dedupe', () => {
  const ctx = { sessionId: 's', dirName: 'd' }
  it('removes duplicate keys keeping the first', () => {
    const dupA = userLine('同一段需求提示词内容重复出现')
    const dupB = userLine('同一段需求提示词内容重复出现', { timestamp: '2026-07-05T00:00:00Z' })
    const cands = extractCandidates([dupA, dupB].join('\n'), ctx)
    expect(cands).toHaveLength(2)
    const unique = dedupe(cands)
    expect(unique).toHaveLength(1)
    expect(unique[0].sentAt).toBe('2026-07-04T11:14:13.453Z')
  })
})
