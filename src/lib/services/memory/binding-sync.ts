/**
 * Tool-memory binding sync engine (P2).
 *
 * For each binding: scan the external local dir (`read_dir_recursive`, home-dir
 * validated), filter files by the tool profile's include/exclude globs, and
 * push each surviving file to the shared memory KB under `mountAs/<relpath>`.
 *
 * Push-only (三纪律 §5.1): never writes back to local. Restore (pull) is a
 * separate explicit action (P2b).
 */
import { invoke } from '@tauri-apps/api/core'
import { syncBatch, fetchManifest, fetchRaw, createKb, listKbs } from '$lib/services/kb-sync/picora-kb-client'
import type { SyncOp } from '$lib/services/kb-sync/types'
import type { MemoryBinding } from './tool-profiles'
import { includedByProfile, getToolProfile, isSuggestableHiddenDir } from './tool-profiles'
import { resolveMemoryContext, resolveAccount } from './cloud-sync'
import { mergeMemoryFile } from './memory-merge'
import * as store from './store'

const MAX_SYNC_OPS = 100 // Picora per-request op cap

interface CloudCtx { apiBase: string; apiKey: string; kbId: string }

/**
 * Resolve the target KB context for a binding: a dedicated KB (Tier 2) when the
 * binding carries `kbId`, otherwise the shared "AI Memory" KB (Tier 1).
 */
async function resolveBindingCtx(binding: MemoryBinding): Promise<CloudCtx | null> {
  if (binding.kbId) {
    const acct = await resolveAccount()
    if (!acct) return null
    return { apiBase: acct.apiBase, apiKey: acct.apiKey, kbId: binding.kbId }
  }
  return resolveMemoryContext()
}

interface FileEntry {
  name: string
  path: string
  is_dir: boolean
  children?: FileEntry[]
}

// Injectable I/O for tests (avoids Tauri runtime).
export interface BindingSyncIO {
  resolveHome(path: string): Promise<string>
  readDir(absPath: string): Promise<FileEntry[]>
  readFile(absPath: string): Promise<string>
  writeFile(absPath: string, content: string): Promise<void>
  dirExists(absPath: string): Promise<boolean>
  /**
   * List immediate hidden (dot-prefixed) directory children of `absPath`, one
   * level deep. `read_dir_recursive` (used by `readDir`) intentionally hides
   * dotfiles for KB file-tree browsing, so the home-dir memory-dir scan needs
   * a separate command that doesn't.
   */
  listHiddenDirs(absPath: string): Promise<FileEntry[]>
}

const tauriIO: BindingSyncIO = {
  async resolveHome(p: string): Promise<string> {
    if (p.startsWith('~')) {
      const { homeDir } = await import('@tauri-apps/api/path')
      const home = (await homeDir()).replace(/[/\\]$/, '')
      return home + p.slice(1)
    }
    return p
  },
  readDir(absPath: string): Promise<FileEntry[]> {
    return invoke<FileEntry[]>('read_dir_recursive', { path: absPath, depth: 10, allFiles: true })
  },
  readFile(absPath: string): Promise<string> {
    return invoke<string>('read_file', { path: absPath })
  },
  async writeFile(absPath: string, content: string): Promise<void> {
    await invoke('write_file', { path: absPath, content })
  },
  async dirExists(absPath: string): Promise<boolean> {
    try {
      await invoke<FileEntry[]>('read_dir_recursive', { path: absPath, depth: 1, allFiles: true })
      return true
    } catch {
      return false
    }
  },
  listHiddenDirs(absPath: string): Promise<FileEntry[]> {
    return invoke<FileEntry[]>('list_hidden_dirs', { path: absPath })
  },
}

let io: BindingSyncIO = tauriIO
export function _setBindingSyncIO(next: BindingSyncIO | null): void {
  io = next ?? tauriIO
}

/** Flatten the FileEntry tree to `{ rel, abs }` for every file (posix rel paths). */
export function flattenFiles(entries: FileEntry[], rootAbs: string): Array<{ rel: string; abs: string }> {
  const out: Array<{ rel: string; abs: string }> = []
  const prefix = rootAbs.replace(/[/\\]$/, '')
  const walk = (list: FileEntry[]): void => {
    for (const e of list) {
      if (e.is_dir) {
        if (e.children) walk(e.children)
      } else {
        let rel = e.path.startsWith(prefix) ? e.path.slice(prefix.length) : e.name
        rel = rel.replace(/^[/\\]+/, '').replace(/\\/g, '/')
        out.push({ rel, abs: e.path })
      }
    }
  }
  walk(entries)
  return out
}

/** Best-effort push-only sync of one binding. */
export async function syncBinding(binding: MemoryBinding): Promise<{ pushed: number; skipped: number }> {
  const ctx = await resolveBindingCtx(binding)
  if (!ctx) return { pushed: 0, skipped: 0 }

  let rootAbs: string
  let tree: FileEntry[]
  try {
    rootAbs = (await io.resolveHome(binding.externalPath)).replace(/[/\\]$/, '')
    tree = await io.readDir(rootAbs)
  } catch {
    return { pushed: 0, skipped: 0 }
  }

  const files = flattenFiles(tree, rootAbs)
  const ops: SyncOp[] = []
  let skipped = 0
  for (const f of files) {
    if (!includedByProfile(f.rel, binding)) { skipped++; continue }
    try {
      const content = await io.readFile(f.abs)
      ops.push({ op: 'upsert', relativePath: `${binding.mountAs}/${f.rel}`, content })
    } catch {
      skipped++
    }
  }

  let pushed = 0
  for (let i = 0; i < ops.length; i += MAX_SYNC_OPS) {
    const batch = ops.slice(i, i + MAX_SYNC_OPS)
    await syncBatch(ctx.apiBase, ctx.apiKey, ctx.kbId, batch)
    pushed += batch.length
  }
  return { pushed, skipped }
}

/** Sync every configured binding. */
export async function syncAllBindings(): Promise<{ pushed: number; skipped: number }> {
  const bindings = await store.getBindings()
  let pushed = 0
  let skipped = 0
  for (const b of bindings) {
    const r = await syncBinding(b)
    pushed += r.pushed
    skipped += r.skipped
  }
  return { pushed, skipped }
}

/**
 * Explicit restore (三纪律 §5.2) with cross-machine merge (§6): pull a binding's
 * cloud files into the local external dir.
 *   - local missing  → write remote (restored)
 *   - local differs  → auto-merge (union for index files, line-merge otherwise;
 *                      merged written in place = merged)
 *   - overlapping conflict → keep local, write remote to `<file>.remote`
 *                      (non-destructive; conflicts)
 */
export async function restoreBinding(
  binding: MemoryBinding,
): Promise<{ restored: number; merged: number; conflicts: number }> {
  const zero = { restored: 0, merged: 0, conflicts: 0 }
  const ctx = await resolveBindingCtx(binding)
  if (!ctx) return zero

  const rootAbs = (await io.resolveHome(binding.externalPath)).replace(/[/\\]$/, '')
  const nsPrefix = `${binding.mountAs}/`

  // Existing local files: rel → abs (for merge).
  const localMap = new Map<string, string>()
  try {
    for (const f of flattenFiles(await io.readDir(rootAbs), rootAbs)) localMap.set(f.rel, f.abs)
  } catch {
    /* dir may not exist yet — everything is "missing" */
  }

  let manifest: Array<{ relativePath: string }>
  try {
    manifest = await fetchManifest(ctx.apiBase, ctx.apiKey, ctx.kbId)
  } catch {
    return zero
  }

  let restored = 0
  let merged = 0
  let conflicts = 0
  for (const entry of manifest) {
    if (!entry.relativePath.startsWith(nsPrefix)) continue
    const rel = entry.relativePath.slice(nsPrefix.length)
    if (!rel) continue
    try {
      const remote = await fetchRaw(ctx.apiBase, ctx.apiKey, ctx.kbId, entry.relativePath)
      const localAbs = localMap.get(rel)
      if (!localAbs) {
        await io.writeFile(`${rootAbs}/${rel}`, remote)
        restored++
        continue
      }
      const local = await io.readFile(localAbs)
      const outcome = mergeMemoryFile(rel, local, remote)
      if (outcome.conflict) {
        await io.writeFile(`${localAbs}.remote`, remote) // keep both, non-destructive
        conflicts++
      } else if (outcome.merged != null && outcome.merged !== local) {
        await io.writeFile(localAbs, outcome.merged)
        merged++
      }
      // identical → skip
    } catch {
      /* skip this file, continue */
    }
  }
  return { restored, merged, conflicts }
}

/** List the account's KBs for a target picker ({id, name, slug}). */
export async function listAvailableKbs(): Promise<Array<{ id: string; name: string; slug?: string }>> {
  const acct = await resolveAccount()
  if (!acct) return []
  try {
    const kbs = await listKbs(acct.apiBase, acct.apiKey)
    return kbs.map(k => ({ id: k.id, name: k.name, slug: k.slug }))
  } catch {
    return []
  }
}

async function cleanNamespace(ctx: CloudCtx, mountAs: string): Promise<void> {
  try {
    const manifest = await fetchManifest(ctx.apiBase, ctx.apiKey, ctx.kbId)
    const nsPrefix = `${mountAs}/`
    const ops: SyncOp[] = manifest
      .filter(e => e.relativePath.startsWith(nsPrefix))
      .map(e => ({ op: 'delete', relativePath: e.relativePath }))
    for (let i = 0; i < ops.length; i += MAX_SYNC_OPS) {
      await syncBatch(ctx.apiBase, ctx.apiKey, ctx.kbId, ops.slice(i, i + MAX_SYNC_OPS))
    }
  } catch {
    /* cleanup is best-effort */
  }
}

/**
 * Route a binding to a target KB (Tier 2): an existing KB (`kbId`) or the shared
 * "AI Memory" KB (`null`). Persists the routing, syncs to the new target, and
 * clears the namespace from the previous target. Returns the updated binding.
 */
export async function routeBindingToKb(
  binding: MemoryBinding,
  newKbId: string | null,
): Promise<MemoryBinding | null> {
  const acct = await resolveAccount()
  if (!acct) return null
  const oldKbId = binding.kbId ?? null
  if (oldKbId === newKbId) return binding // no change

  const updated: MemoryBinding = { ...binding }
  if (newKbId) updated.kbId = newKbId
  else delete updated.kbId
  const all = await store.getBindings()
  await store.setBindings(all.map(b => (b.mountAs === binding.mountAs ? updated : b)))

  await syncBinding(updated) // push into the new target

  // Clear the namespace from the previous target.
  const oldCtx = oldKbId
    ? { apiBase: acct.apiBase, apiKey: acct.apiKey, kbId: oldKbId }
    : await resolveMemoryContext()
  if (oldCtx) await cleanNamespace(oldCtx, binding.mountAs)
  return updated
}

/**
 * Tier 2 convenience: create a NEW dedicated KB and route the binding into it.
 */
export async function moveBindingToDedicatedKb(
  binding: MemoryBinding,
  kbName: string,
): Promise<MemoryBinding | null> {
  const acct = await resolveAccount()
  if (!acct) return null
  let kbId: string
  try {
    const kb = await createKb(acct.apiBase, acct.apiKey, kbName)
    if (!kb?.id) return null
    kbId = kb.id
  } catch {
    return null
  }
  return routeBindingToKb(binding, kbId)
}

/**
 * Scan the top level of the home directory for hidden dirs worth suggesting as
 * AI memory dirs (dot-prefixed, minus system/secret/toolchain noise). Only
 * looks at the direct listing of `~/` — never recurses into the suggested
 * dirs themselves. Returns `{ name, path }` sorted by name. Best-effort:
 * returns [] on any I/O error.
 */
export async function scanHomeMemoryDirs(): Promise<Array<{ name: string; path: string }>> {
  let homeAbs: string
  let entries: FileEntry[]
  try {
    homeAbs = (await io.resolveHome('~')).replace(/[/\\]$/, '')
    entries = await io.listHiddenDirs(homeAbs)
  } catch {
    return []
  }
  return entries
    .filter((e) => e.is_dir && isSuggestableHiddenDir(e.name))
    .map((e) => ({ name: e.name, path: e.path }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Recommend probe: does this tool's default memory dir exist locally? */
export async function toolDirPresent(tool: string): Promise<boolean> {
  const profile = getToolProfile(tool)
  if (!profile) return false
  try {
    const abs = (await io.resolveHome(profile.defaultRoot)).replace(/[/\\]$/, '')
    return await io.dirExists(abs)
  } catch {
    return false
  }
}
