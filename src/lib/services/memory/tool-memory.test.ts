import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ── Mocks (hoisted) ─────────────────────────────────────────────────────────
const h = vi.hoisted(() => ({
  ctx: { apiBase: 'https://api.test', apiKey: 'k', kbId: 'kb_mem' } as { apiBase: string; apiKey: string; kbId: string } | null,
  account: { apiBase: 'https://api.test', apiKey: 'k', targetId: 't1' } as { apiBase: string; apiKey: string; targetId: string } | null,
  syncCalls: [] as Array<{ kbId: string; ops: unknown[] }>,
  manifest: [] as Array<{ relativePath: string; sourceHash: string; sizeBytes: number; updatedAt: string }>,
  raw: new Map<string, string>(),
  createdKbId: 'kb_dedicated',
  createKbCalls: [] as string[],
}))

vi.mock('./cloud-sync', () => ({
  resolveMemoryContext: async () => h.ctx,
  resolveAccount: async () => h.account,
}))
vi.mock('$lib/services/kb-sync/picora-kb-client', () => ({
  syncBatch: async (_apiBase: string, _apiKey: string, kbId: string, ops: unknown[]) => {
    h.syncCalls.push({ kbId, ops })
    return { applied: ops.map(() => 'ok'), conflicts: [] }
  },
  fetchManifest: async () => h.manifest,
  fetchRaw: async (_a: string, _b: string, _c: string, path: string) => h.raw.get(path) ?? '',
  createKb: async (_a: string, _b: string, name: string) => {
    h.createKbCalls.push(name)
    return { id: h.createdKbId, name, slug: name, description: null, docCount: 0, sizeBytes: 0, createdAt: '', updatedAt: '' }
  },
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
import { flattenFiles, syncBinding, syncAllBindings, restoreBinding, toolDirPresent, moveBindingToDedicatedKb, _setBindingSyncIO } from './binding-sync'
import type { BindingSyncIO } from './binding-sync'
import { isIndexFile, unionMergeLines, mergeMemoryFile } from './memory-merge'

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

  it('fills missing files on a new machine', async () => {
    const writes: string[] = []
    _setBindingSyncIO(makeIO({
      async readDir() { throw new Error('no dir') }, // dir absent → everything missing
      async writeFile(path) { writes.push(path) },
    }))
    const r = await restoreBinding(bindingFromProfile(TOOL_PROFILES.claude, '~/.claude'))
    expect(r).toEqual({ restored: 2, merged: 0, conflicts: 0 })
    expect(writes.sort()).toEqual(['/home/u/.claude/CLAUDE.md', '/home/u/.claude/agents/r.md'])
  })

  it('union-merges an index file (MEMORY.md) appended on both machines', async () => {
    h.manifest = [{ relativePath: '.claude/MEMORY.md', sourceHash: 'h', sizeBytes: 1, updatedAt: '2026-07-06T00:00:00Z' }]
    h.raw = new Map([['.claude/MEMORY.md', '- a\n- b\n']]) // remote: a,b
    const writes: Array<{ path: string; content: string }> = []
    _setBindingSyncIO(makeIO({
      async readDir() { return [{ name: 'MEMORY.md', path: '/home/u/.claude/MEMORY.md', is_dir: false }] },
      async readFile() { return '- a\n- c\n' }, // local: a,c
      async writeFile(path, content) { writes.push({ path, content }) },
    }))
    const r = await restoreBinding(bindingFromProfile(TOOL_PROFILES.claude, '~/.claude'))
    expect(r.merged).toBe(1)
    expect(writes[0].path).toBe('/home/u/.claude/MEMORY.md')
    expect(writes[0].content).toContain('- c') // local preserved
    expect(writes[0].content).toContain('- b') // remote-only appended
  })

  it('keeps both on a non-index conflict (writes .remote, non-destructive)', async () => {
    h.manifest = [{ relativePath: '.claude/CLAUDE.md', sourceHash: 'h', sizeBytes: 1, updatedAt: '2026-07-06T00:00:00Z' }]
    h.raw = new Map([['.claude/CLAUDE.md', 'rule X\n']])
    const writes: Array<{ path: string; content: string }> = []
    _setBindingSyncIO(makeIO({
      async readDir() { return [{ name: 'CLAUDE.md', path: '/home/u/.claude/CLAUDE.md', is_dir: false }] },
      async readFile() { return 'rule Y\n' }, // differs (overlapping)
      async writeFile(path, content) { writes.push({ path, content }) },
    }))
    const r = await restoreBinding(bindingFromProfile(TOOL_PROFILES.claude, '~/.claude'))
    expect(r.conflicts).toBe(1)
    expect(r.merged).toBe(0)
    expect(writes[0].path).toBe('/home/u/.claude/CLAUDE.md.remote') // remote saved as sidecar
    expect(writes[0].content).toBe('rule X\n')
  })

  it('no-op without cloud context', async () => {
    h.ctx = null
    _setBindingSyncIO(makeIO({}))
    expect(await restoreBinding(bindingFromProfile(TOOL_PROFILES.claude, '~/.claude'))).toEqual({ restored: 0, merged: 0, conflicts: 0 })
  })
})

// ── cross-machine memory merge (§6) ──────────────────────────────────────────

describe('memory-merge', () => {
  it('isIndexFile detects append/index files', () => {
    expect(isIndexFile('.moraya/memories/../MEMORY.md')).toBe(true)
    expect(isIndexFile('MEMORY.md')).toBe(true)
    expect(isIndexFile('foo/index.json')).toBe(true)
    expect(isIndexFile('CLAUDE.md')).toBe(false)
    expect(isIndexFile('agents/r.md')).toBe(false)
  })
  it('unionMergeLines dedups and appends remote-only lines', () => {
    expect(unionMergeLines('a\nb\n', 'a\nc\n')).toBe('a\nb\nc\n')
    expect(unionMergeLines('a\nb\n', 'a\nb\n')).toBe('a\nb\n') // no change
  })
  it('mergeMemoryFile: identical → no change', () => {
    expect(mergeMemoryFile('x.md', 'a', 'a')).toEqual({ merged: 'a', conflict: false })
  })
  it('mergeMemoryFile: index → union (auto-merge)', () => {
    const o = mergeMemoryFile('MEMORY.md', '- a\n', '- a\n- b\n')
    expect(o.conflict).toBe(false)
    expect(o.merged).toContain('- b')
  })
  it('mergeMemoryFile: non-index overlapping change → conflict', () => {
    const o = mergeMemoryFile('CLAUDE.md', 'x', 'y')
    expect(o.conflict).toBe(true)
    expect(o.merged).toBeNull()
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

// ── Tier 2: dedicated tool KB ────────────────────────────────────────────────

describe('moveBindingToDedicatedKb', () => {
  const disk = new Map<string, unknown>()
  beforeEach(() => {
    disk.clear()
    store.setMemoryPersistence({
      async read<T>(k: string) { return (disk.has(k) ? (disk.get(k) as T) : null) },
      async write(k: string, v: unknown) { disk.set(k, v) },
    })
    store._resetCache()
    h.ctx = { apiBase: 'https://api.test', apiKey: 'k', kbId: 'kb_mem' }
    h.account = { apiBase: 'https://api.test', apiKey: 'k', targetId: 't1' }
    h.syncCalls = []
    h.createKbCalls = []
    h.createdKbId = 'kb_dedicated'
    h.manifest = [{ relativePath: '.claude/CLAUDE.md', sourceHash: 'h', sizeBytes: 1, updatedAt: '2026-07-06T00:00:00Z' }]
    _setBindingSyncIO(makeIO({
      async readDir() { return [{ name: 'CLAUDE.md', path: '/home/u/.claude/CLAUDE.md', is_dir: false }] },
      async readFile() { return 'rules' },
    }))
  })
  afterEach(() => { store.setMemoryPersistence(null); _setBindingSyncIO(null) })

  it('creates a KB, routes the binding, syncs there, and clears the shared namespace', async () => {
    await addToolBinding('claude')
    const [binding] = await store.getBindings()
    const updated = await moveBindingToDedicatedKb(binding, 'My Claude')

    expect(updated?.kbId).toBe('kb_dedicated')
    expect(h.createKbCalls).toEqual(['My Claude'])
    // persisted routing
    expect((await store.getBindings())[0].kbId).toBe('kb_dedicated')
    // pushed to the dedicated KB
    expect(h.syncCalls.some(c => c.kbId === 'kb_dedicated')).toBe(true)
    // deleted the namespace from the shared KB
    const sharedDeletes = h.syncCalls.filter(c => c.kbId === 'kb_mem')
      .flatMap(c => c.ops as Array<{ op: string; relativePath: string }>)
    expect(sharedDeletes).toEqual([{ op: 'delete', relativePath: '.claude/CLAUDE.md' }])
  })

  it('a routed binding syncs to its dedicated KB, not the shared one', async () => {
    await addToolBinding('claude')
    const all = await store.getBindings()
    all[0].kbId = 'kb_dedicated'
    await store.setBindings(all)
    h.syncCalls = []
    await syncBinding(all[0])
    expect(h.syncCalls.every(c => c.kbId === 'kb_dedicated')).toBe(true)
  })
})
