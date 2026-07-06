/**
 * PC memory cloud sync → Picora dot-directory hosting (`.moraya/memories/*.md`).
 *
 * Reuses the KB-sync Picora client (Rust `invoke`) and `@moraya/core/memory`
 * serialization so PC writes byte-identical files to web/mobile. Which Picora
 * account + KB to use is a user choice stored in the memory cloud config
 * (a Picora-connected `imageHostTargets` entry + a KB id).
 *
 * Best-effort throughout: Picora unreachable → memory still lives locally.
 * Picora's per-file delete (no tree endpoint) means "clear cloud" enumerates
 * the manifest and deletes each memory file.
 */
import { writable, derived, get } from 'svelte/store'
import {
  serializeMemoryDoc,
  parseMemoryDoc,
  memoryDocPath,
  memoryIdFromPath,
  MEMORY_DIR,
} from '@moraya/core/memory'
import type { MemoryDoc } from './types'
import * as store from './store'
import { settingsStore } from '$lib/stores/settings-store'
import { picoraApiBase, syncBatch, fetchManifest, fetchRaw } from '$lib/services/kb-sync/picora-kb-client'
import type { SyncOp } from '$lib/services/kb-sync/types'
import { getPicoraApiKey } from '$lib/services/picora/credentials'

const PREFIX = `${MEMORY_DIR}/` // ".moraya/memories/"

export type MemorySyncStatusKind = 'disabled' | 'idle' | 'syncing' | 'error' | 'offline'
const statusStore = writable<MemorySyncStatusKind>('disabled')
export const memorySyncStatus = derived(statusStore, s => s)

let pending = 0
function begin() { if (++pending === 1) statusStore.set('syncing') }
function end(err: boolean) { if (Math.max(0, --pending) === 0) statusStore.set(err ? 'error' : 'idle') }

interface CloudContext {
  apiBase: string
  apiKey: string
  kbId: string
}

async function resolveContext(): Promise<CloudContext | null> {
  const cfg = await store.getCloudConfig()
  if (!cfg.enabled || !cfg.targetId || !cfg.kbId) return null
  const target = get(settingsStore).imageHostTargets.find(t => t.id === cfg.targetId)
  if (!target || !target.picoraApiUrl) return null
  try {
    const apiKey = await getPicoraApiKey(target)
    if (!apiKey) return null
    return { apiBase: picoraApiBase(target.picoraApiUrl), apiKey, kbId: cfg.kbId }
  } catch {
    return null
  }
}

/** Best-effort push of one memory to Picora. */
export async function pushMemory(doc: MemoryDoc): Promise<void> {
  const ctx = await resolveContext()
  if (!ctx) { statusStore.set(await isConfigured() ? 'offline' : 'disabled'); return }
  begin()
  let err = false
  try {
    const op: SyncOp = { op: 'upsert', relativePath: memoryDocPath(doc.id), content: serializeMemoryDoc(doc) }
    await syncBatch(ctx.apiBase, ctx.apiKey, ctx.kbId, [op])
  } catch (e) {
    err = true
    console.warn('[memory-sync] push failed', doc.id, e)
  } finally {
    end(err)
  }
}

/** Best-effort delete of a memory's cloud copy. */
export async function deleteRemoteMemory(id: string): Promise<void> {
  const ctx = await resolveContext()
  if (!ctx) return
  try {
    await syncBatch(ctx.apiBase, ctx.apiKey, ctx.kbId, [{ op: 'delete', relativePath: memoryDocPath(id) }])
  } catch (e) {
    console.warn('[memory-sync] delete failed', id, e)
  }
}

/** Delete every memory file in the cloud (enumerate manifest → batch delete). */
export async function clearRemoteMemories(): Promise<{ deleted: number }> {
  const ctx = await resolveContext()
  if (!ctx) return { deleted: 0 }
  const manifest = await fetchManifest(ctx.apiBase, ctx.apiKey, ctx.kbId)
  const ops: SyncOp[] = manifest
    .filter(e => e.relativePath.startsWith(PREFIX))
    .map(e => ({ op: 'delete', relativePath: e.relativePath }))
  if (ops.length === 0) return { deleted: 0 }
  const res = await syncBatch(ctx.apiBase, ctx.apiKey, ctx.kbId, ops)
  return { deleted: res.applied.length }
}

/**
 * Pull-and-merge: remote newer → pull; local-only active → push.
 * Newness compares the manifest `updatedAt` against local `lastUsedAt`.
 */
export async function syncNow(): Promise<{ pulled: number; pushed: number }> {
  const ctx = await resolveContext()
  if (!ctx) { statusStore.set(await isConfigured() ? 'offline' : 'disabled'); return { pulled: 0, pushed: 0 } }
  let pulled = 0
  let pushed = 0
  begin()
  let err = false
  try {
    const manifest = await fetchManifest(ctx.apiBase, ctx.apiKey, ctx.kbId)
    const localAll = await store.getAll(true)
    const localById = new Map(localAll.map(d => [d.id, d] as const))

    for (const entry of manifest) {
      if (!entry.relativePath.startsWith(PREFIX)) continue
      const id = memoryIdFromPath(entry.relativePath)
      if (!id) continue
      const remoteTs = new Date(entry.updatedAt).getTime() || 0
      const local = localById.get(id)
      localById.delete(id)
      if (local && new Date(local.lastUsedAt).getTime() >= remoteTs) continue
      try {
        const raw = await fetchRaw(ctx.apiBase, ctx.apiKey, ctx.kbId, entry.relativePath)
        const doc = parseMemoryDoc(raw, id)
        if (doc) { await store.put(doc); pulled++ }
      } catch (e) {
        console.warn('[memory-sync] pull failed', id, e)
      }
    }

    // Local-only active memories → push.
    const upserts: SyncOp[] = []
    for (const doc of localById.values()) {
      if (doc.status !== 'active') continue
      upserts.push({ op: 'upsert', relativePath: memoryDocPath(doc.id), content: serializeMemoryDoc(doc) })
    }
    if (upserts.length > 0) {
      await syncBatch(ctx.apiBase, ctx.apiKey, ctx.kbId, upserts)
      pushed = upserts.length
    }
  } catch (e) {
    err = true
    console.warn('[memory-sync] sync failed', e)
  } finally {
    end(err)
  }
  return { pulled, pushed }
}

/** True when a Picora target + KB are selected and sync is enabled. */
export async function isConfigured(): Promise<boolean> {
  const cfg = await store.getCloudConfig()
  return cfg.enabled && !!cfg.targetId && !!cfg.kbId
}
