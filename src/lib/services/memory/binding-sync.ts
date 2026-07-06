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
import { syncBatch, fetchManifest, fetchRaw, createKb } from '$lib/services/kb-sync/picora-kb-client'
import type { SyncOp } from '$lib/services/kb-sync/types'
import type { MemoryBinding } from './tool-profiles'
import { includedByProfile, getToolProfile } from './tool-profiles'
import { resolveMemoryContext, resolveAccount } from './cloud-sync'
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
 * Explicit restore (三纪律 §5.2): pull a binding's cloud files into the local
 * external dir, writing ONLY files that don't already exist locally — never
 * overwriting. Used on a new machine to recover a tool's memory backup.
 */
export async function restoreBinding(binding: MemoryBinding): Promise<{ restored: number }> {
  const ctx = await resolveBindingCtx(binding)
  if (!ctx) return { restored: 0 }

  const rootAbs = (await io.resolveHome(binding.externalPath)).replace(/[/\\]$/, '')
  const nsPrefix = `${binding.mountAs}/`

  // Existing local files (to skip — never overwrite).
  const localRels = new Set<string>()
  try {
    for (const f of flattenFiles(await io.readDir(rootAbs), rootAbs)) localRels.add(f.rel)
  } catch {
    /* dir may not exist yet — everything is "missing" */
  }

  let manifest: Array<{ relativePath: string }>
  try {
    manifest = await fetchManifest(ctx.apiBase, ctx.apiKey, ctx.kbId)
  } catch {
    return { restored: 0 }
  }

  let restored = 0
  for (const entry of manifest) {
    if (!entry.relativePath.startsWith(nsPrefix)) continue
    const rel = entry.relativePath.slice(nsPrefix.length)
    if (!rel || localRels.has(rel)) continue // only fill missing
    try {
      const content = await fetchRaw(ctx.apiBase, ctx.apiKey, ctx.kbId, entry.relativePath)
      await io.writeFile(`${rootAbs}/${rel}`, content)
      restored++
    } catch {
      /* skip this file, continue */
    }
  }
  return { restored }
}

/**
 * Tier 2 (Picora 设计 §12): split a binding's memory out to a dedicated KB.
 * Creates an ordinary KB, routes the binding there, re-syncs, and removes the
 * namespace from the shared "AI Memory" KB. Returns the updated binding.
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

  // Route the binding to the dedicated KB and persist.
  const updated: MemoryBinding = { ...binding, kbId }
  const all = await store.getBindings()
  await store.setBindings(all.map(b => (b.mountAs === binding.mountAs ? updated : b)))

  // Push into the new KB.
  await syncBinding(updated)

  // Remove the namespace from the shared KB (best-effort cleanup).
  const shared = await resolveMemoryContext()
  if (shared) {
    try {
      const manifest = await fetchManifest(shared.apiBase, shared.apiKey, shared.kbId)
      const nsPrefix = `${binding.mountAs}/`
      const ops: SyncOp[] = manifest
        .filter(e => e.relativePath.startsWith(nsPrefix))
        .map(e => ({ op: 'delete', relativePath: e.relativePath }))
      for (let i = 0; i < ops.length; i += MAX_SYNC_OPS) {
        await syncBatch(shared.apiBase, shared.apiKey, shared.kbId, ops.slice(i, i + MAX_SYNC_OPS))
      }
    } catch {
      /* cleanup is best-effort */
    }
  }
  return updated
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
