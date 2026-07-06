import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ── Mocks (hoisted) ─────────────────────────────────────────────────────────
const h = vi.hoisted(() => ({
  ctx: { apiBase: 'https://api.test', apiKey: 'k', kbId: 'kb_mem' } as { apiBase: string; apiKey: string; kbId: string } | null,
  syncCalls: [] as Array<{ kbId: string; ops: unknown[] }>,
  manifest: [] as Array<{ relativePath: string; sourceHash: string; sizeBytes: number; updatedAt: string }>,
  raw: new Map<string, string>(),
}))

vi.mock('./cloud-sync', () => ({
  resolveMemoryContext: async () => h.ctx,
}))
vi.mock('$lib/services/kb-sync/picora-kb-client', () => ({
  syncBatch: async (_apiBase: string, _apiKey: string, kbId: string, ops: unknown[]) => {
    h.syncCalls.push({ kbId, ops })
    return { applied: ops.map(() => 'ok'), conflicts: [] }
  },
  fetchManifest: async () => h.manifest,
  fetchRaw: async (_a: string, _b: string, _c: string, path: string) => h.raw.get(path) ?? '',
}))

import {
  globToRegExp,
  includedByProfile,
  getToolProfile,
  bindingFromProfile,
  TOOL_PROFILES,
} from './tool-profiles'
import * as store from './store'
import { addToolBinding, removeBinding, listBindings, hasBinding } from './bindings'
import { flattenFiles, syncBinding, syncAllBindings, restoreBinding, toolDirPresent, _setBindingSyncIO } from './binding-sync'
import type { BindingSyncIO } from './binding-sync'

// A no-op-ish IO the sync tests can spread over.
function makeIO(over: Partial<BindingSyncIO>): BindingSyncIO {
  return {
    async resolveHome(p) { return p.replace('~', '/home/u') },
    async readDir() { return [] },
    async readFile() { return '' },
    async writeFile() { /* noop */ },
    async dirExists() { return true },
    ...over,
  }
}

// ── tool-profiles: glob + include/exclude ───────────────────────────────────

describe('globToRegExp', () => {
  const cases: Array<[string, string, boolean]> = [
    ['CLAUDE.md', 'CLAUDE.md', true],
    ['CLAUDE.md', 'claude.md', false],
    ['projects/*/memory/**', 'projects/foo/memory/a.md', true],
    ['projects/*/memory/**', 'projects/foo/memory/sub/b.md', true],
    ['projects/*/memory/**', 'projects/foo/notes.md', false],
    ['agents/**', 'agents/x/y.md', true],
    ['**/*.jsonl', 'projects/foo/memory/log.jsonl', true],
    ['**/*.jsonl', 'root.jsonl', true],
    ['settings*.json', 'settings.json', true],
    ['settings*.json', 'settings.local.json', true],
    ['settings*.json', 'other.json', false],
  ]
  it.each(cases)('%s vs %s → %s', (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected)
  })
})

describe('includedByProfile (claude)', () => {
  const claude = TOOL_PROFILES.claude
  const sync = (p: string) => includedByProfile(p, claude)

  it('syncs memory + rules + agents', () => {
    expect(sync('projects/foo/memory/a.md')).toBe(true)
    expect(sync('CLAUDE.md')).toBe(true)
    expect(sync('agents/reviewer.md')).toBe(true)
  })
  it('hard-excludes transcripts, settings, runtime noise (exclude wins over include)', () => {
    expect(sync('projects/foo/memory/log.jsonl')).toBe(false) // matches include AND exclude → excluded
    expect(sync('settings.json')).toBe(false)
    expect(sync('settings.local.json')).toBe(false)
    expect(sync('shell-snapshots/x.sh')).toBe(false)
    expect(sync('todos/t.json')).toBe(false)
  })
  it('skips unrelated files (no include match)', () => {
    expect(sync('README.md')).toBe(false)
    expect(sync('projects/foo/session.md')).toBe(false)
  })
})

describe('profiles', () => {
  it('moraya profile is full-include', () => {
    expect(includedByProfile('memories/x.md', TOOL_PROFILES.moraya)).toBe(true)
    expect(includedByProfile('MEMORY.md', TOOL_PROFILES.moraya)).toBe(true)
  })
  it('getToolProfile returns null for unknown tools', () => {
    expect(getToolProfile('nope')).toBeNull()
  })
  it('bindingFromProfile pins path + copies globs', () => {
    const b = bindingFromProfile(TOOL_PROFILES.claude, '/Users/x/.claude')
    expect(b.mountAs).toBe('.claude')
    expect(b.externalPath).toBe('/Users/x/.claude')
    expect(b.exclude).toContain('**/*.jsonl')
  })
})

// ── bindings CRUD (real store + in-memory persistence) ──────────────────────

describe('bindings CRUD', () => {
  const disk = new Map<string, unknown>()
  beforeEach(() => {
    disk.clear()
    store.setMemoryPersistence({
      async read<T>(k: string) { return (disk.has(k) ? (disk.get(k) as T) : null) },
      async write(k: string, v: unknown) { disk.set(k, v) },
    })
    store._resetCache()
  })
  afterEach(() => store.setMemoryPersistence(null))

  it('adds a tool binding from profile', async () => {
    const b = await addToolBinding('claude')
    expect(b?.mountAs).toBe('.claude')
    expect(await listBindings()).toHaveLength(1)
    expect(await hasBinding('.claude')).toBe(true)
  })
  it('is idempotent by mountAs (re-add refreshes, no dup)', async () => {
    await addToolBinding('claude')
    await addToolBinding('claude', '/custom/.claude')
    const list = await listBindings()
    expect(list).toHaveLength(1)
    expect(list[0].externalPath).toBe('/custom/.claude')
  })
  it('returns null for unknown tool', async () => {
    expect(await addToolBinding('nope')).toBeNull()
  })
  it('removes a binding', async () => {
    await addToolBinding('claude')
    await removeBinding('.claude')
    expect(await listBindings()).toHaveLength(0)
  })
})

// ── binding-sync engine ─────────────────────────────────────────────────────

describe('flattenFiles', () => {
  it('flattens a tree to posix rel paths', () => {
    const tree = [
      { name: 'CLAUDE.md', path: '/root/CLAUDE.md', is_dir: false },
      { name: 'agents', path: '/root/agents', is_dir: true, children: [
        { name: 'r.md', path: '/root/agents/r.md', is_dir: false },
      ] },
    ]
    expect(flattenFiles(tree, '/root')).toEqual([
      { rel: 'CLAUDE.md', abs: '/root/CLAUDE.md' },
      { rel: 'agents/r.md', abs: '/root/agents/r.md' },
    ])
  })
})

describe('syncBinding', () => {
  beforeEach(() => {
    h.ctx = { apiBase: 'https://api.test', apiKey: 'k', kbId: 'kb_mem' }
    h.syncCalls = []
    _setBindingSyncIO(makeIO({
      async readDir() {
        return [
          { name: 'CLAUDE.md', path: '/home/u/.claude/CLAUDE.md', is_dir: false },
          { name: 'projects', path: '/home/u/.claude/projects', is_dir: true, children: [
            { name: 'p1', path: '/home/u/.claude/projects/p1', is_dir: true, children: [
              { name: 'memory', path: '/home/u/.claude/projects/p1/memory', is_dir: true, children: [
                { name: 'a.md', path: '/home/u/.claude/projects/p1/memory/a.md', is_dir: false },
                { name: 'log.jsonl', path: '/home/u/.claude/projects/p1/memory/log.jsonl', is_dir: false },
              ] },
            ] },
          ] },
          { name: 'settings.json', path: '/home/u/.claude/settings.json', is_dir: false },
        ]
      },
      async readFile(abs) { return `content of ${abs}` },
    }))
  })
  afterEach(() => _setBindingSyncIO(null))

  it('pushes only included files (excludes .jsonl + settings)', async () => {
    const binding = bindingFromProfile(TOOL_PROFILES.claude, '~/.claude')
    const r = await syncBinding(binding)
    expect(r.pushed).toBe(2) // CLAUDE.md + projects/p1/memory/a.md
    const ops = h.syncCalls.flatMap(c => c.ops) as Array<{ relativePath: string }>
    const paths = ops.map(o => o.relativePath).sort()
    expect(paths).toEqual(['.claude/CLAUDE.md', '.claude/projects/p1/memory/a.md'])
  })

  it('mounts under the namespace and targets the memory KB', async () => {
    await syncBinding(bindingFromProfile(TOOL_PROFILES.claude, '~/.claude'))
    expect(h.syncCalls[0].kbId).toBe('kb_mem')
    for (const op of h.syncCalls.flatMap(c => c.ops) as Array<{ relativePath: string }>) {
      expect(op.relativePath.startsWith('.claude/')).toBe(true)
    }
  })

  it('no-op when no cloud context (not signed in)', async () => {
    h.ctx = null
    const r = await syncBinding(bindingFromProfile(TOOL_PROFILES.claude, '~/.claude'))
    expect(r).toEqual({ pushed: 0, skipped: 0 })
    expect(h.syncCalls).toHaveLength(0)
  })
})

describe('syncAllBindings', () => {
  const disk = new Map<string, unknown>()
  beforeEach(() => {
    disk.clear()
    store.setMemoryPersistence({
      async read<T>(k: string) { return (disk.has(k) ? (disk.get(k) as T) : null) },
      async write(k: string, v: unknown) { disk.set(k, v) },
    })
    store._resetCache()
    h.ctx = { apiBase: 'https://api.test', apiKey: 'k', kbId: 'kb_mem' }
    h.syncCalls = []
    _setBindingSyncIO(makeIO({
      async readDir() { return [{ name: 'CLAUDE.md', path: '/home/u/.claude/CLAUDE.md', is_dir: false }] },
      async readFile() { return 'x' },
    }))
  })
  afterEach(() => { store.setMemoryPersistence(null); _setBindingSyncIO(null) })

  it('syncs every configured binding', async () => {
    await addToolBinding('claude')
    const r = await syncAllBindings()
    expect(r.pushed).toBe(1)
  })
})

// ── restore (pull, only-missing) ─────────────────────────────────────────────

describe('restoreBinding', () => {
  beforeEach(() => {
    h.ctx = { apiBase: 'https://api.test', apiKey: 'k', kbId: 'kb_mem' }
    h.manifest = [
      { relativePath: '.claude/CLAUDE.md', sourceHash: 'h1', sizeBytes: 1, updatedAt: '2026-07-06T00:00:00Z' },
      { relativePath: '.claude/agents/r.md', sourceHash: 'h2', sizeBytes: 1, updatedAt: '2026-07-06T00:00:00Z' },
      { relativePath: '.moraya/memories/x.md', sourceHash: 'h3', sizeBytes: 1, updatedAt: '2026-07-06T00:00:00Z' }, // other namespace
    ]
    h.raw = new Map([
      ['.claude/CLAUDE.md', 'rules'],
      ['.claude/agents/r.md', 'agent'],
    ])
  })
  afterEach(() => _setBindingSyncIO(null))

  it('writes only missing files under the binding namespace', async () => {
    const writes: Array<{ path: string; content: string }> = []
    _setBindingSyncIO(makeIO({
      // local already has CLAUDE.md → should be skipped
      async readDir() { return [{ name: 'CLAUDE.md', path: '/home/u/.claude/CLAUDE.md', is_dir: false }] },
      async writeFile(path, content) { writes.push({ path, content }) },
    }))
    const r = await restoreBinding(bindingFromProfile(TOOL_PROFILES.claude, '~/.claude'))
    expect(r.restored).toBe(1) // only agents/r.md (CLAUDE.md exists locally; .moraya not in ns)
    expect(writes).toEqual([{ path: '/home/u/.claude/agents/r.md', content: 'agent' }])
  })

  it('restores all when local dir is empty (new machine)', async () => {
    const writes: string[] = []
    _setBindingSyncIO(makeIO({
      async readDir() { throw new Error('no dir') }, // dir absent
      async writeFile(path) { writes.push(path) },
    }))
    const r = await restoreBinding(bindingFromProfile(TOOL_PROFILES.claude, '~/.claude'))
    expect(r.restored).toBe(2)
    expect(writes.sort()).toEqual(['/home/u/.claude/CLAUDE.md', '/home/u/.claude/agents/r.md'])
  })

  it('no-op without cloud context', async () => {
    h.ctx = null
    _setBindingSyncIO(makeIO({}))
    expect(await restoreBinding(bindingFromProfile(TOOL_PROFILES.claude, '~/.claude'))).toEqual({ restored: 0 })
  })
})

describe('toolDirPresent', () => {
  afterEach(() => _setBindingSyncIO(null))
  it('true when the tool dir exists', async () => {
    _setBindingSyncIO(makeIO({ async dirExists() { return true } }))
    expect(await toolDirPresent('claude')).toBe(true)
  })
  it('false when absent', async () => {
    _setBindingSyncIO(makeIO({ async dirExists() { return false } }))
    expect(await toolDirPresent('claude')).toBe(false)
  })
  it('false for unknown tool', async () => {
    expect(await toolDirPresent('nope')).toBe(false)
  })
})
