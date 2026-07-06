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
import { syncBatch } from '$lib/services/kb-sync/picora-kb-client'
import type { SyncOp } from '$lib/services/kb-sync/types'
import type { MemoryBinding } from './tool-profiles'
import { includedByProfile } from './tool-profiles'
import { resolveMemoryContext } from './cloud-sync'
import * as store from './store'

const MAX_SYNC_OPS = 100 // Picora per-request op cap

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
  const ctx = await resolveMemoryContext()
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
