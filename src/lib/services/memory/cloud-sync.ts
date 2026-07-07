/**
 * PC memory cloud sync → Picora dot-directory hosting (`.moraya/memories/*.md`).
 *
 * Reuses the KB-sync Picora client (Rust `invoke`) and `@moraya/core/memory`
 * serialization so PC writes byte-identical files to web/mobile.
 *
 * Target KB (Tier 1, per Picora AI记忆点目录架构设计 §12): the shared
 * "AI Memory" KB that Picora auto-provisions on OAuth (server v0.71.0
 * `KbService.ensureMemoryKb`, reserved `slug='memory'`). The client only
 * *discovers* it — it does NOT create memory KBs. The only remaining user
 * choice is which authorized Picora account (an `imageHostTargets` entry) the
 * global `~/.moraya` memory belongs to.
 *
 * Best-effort throughout: Picora unreachable → memory still lives locally.
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
import { picoraApiBase, syncBatch, fetchManifest, fetchRaw, listKbs, createKb } from '$lib/services/kb-sync/picora-kb-client'
import type { SyncOp } from '$lib/services/kb-sync/types'
import { getPicoraApiKey } from '$lib/services/picora/credentials'
import { PICORA_DEFAULT_API_URL } from '$lib/services/image-hosting'

const PREFIX = `${MEMORY_DIR}/` // ".moraya/memories/"

/** Reserved slug of Picora's shared "AI Memory" KB (server v0.71.0). */
export const MEMORY_KB_SLUG = 'memory'

export type MemorySyncStatusKind = 'disabled' | 'idle' | 'syncing' | 'error' | 'offline'
const statusStore = writable<MemorySyncStatusKind>('disabled')
export const memorySyncStatus = derived(statusStore, s => s)

let pending = 0
function begin() { if (++pending === 1) statusStore.set('syncing') }
function end(err: boolean) { if (Math.max(0, --pending) === 0) statusStore.set(err ? 'error' : 'idle') }

// Session cache: authorized account (targetId) → discovered memory KB id.
const memoryKbCache = new Map<string, string>()

interface CloudContext {
  apiBase: string
  apiKey: string
  kbId: string
}

/** Account-only context (no KB) — for bindings that route to a dedicated KB. */
export interface AccountContext {
  apiBase: string
  apiKey: string
  targetId: string
}

/** Resolve the selected Picora account's {apiBase, apiKey} (no KB discovery). */
export async function resolveAccount(): Promise<AccountContext | null> {
  const cfg = await store.getCloudConfig()
  if (!cfg.enabled || !cfg.targetId) return null
  const target = get(settingsStore).imageHostTargets.find(t => t.id === cfg.targetId && t.provider === 'picora')
  if (!target) return null
  try {
    const apiKey = await getPicoraApiKey(target)
    if (!apiKey) return null
    // picoraApiUrl may be empty when the account uses the default endpoint.
    const apiBase = picoraApiBase(target.picoraApiUrl || PICORA_DEFAULT_API_URL)
    return { apiBase, apiKey, targetId: cfg.targetId }
  } catch {
    return null
  }
}

/**
 * Discover the shared memory KB (slug='memory'). Picora auto-provisions it on
 * OAuth; if a stale/older account hasn't been re-authed yet and it's missing,
 * self-heal by creating it once (idempotent by reserved slug on the server).
 */
async function discoverMemoryKb(targetId: string, apiBase: string, apiKey: string): Promise<string | null> {
  const cached = memoryKbCache.get(targetId)
  if (cached) return cached
  try {
    const kbs = await listKbs(apiBase, apiKey)
    let kb = kbs.find(k => k.slug === MEMORY_KB_SLUG)
    if (!kb) kb = await createKb(apiBase, apiKey, 'AI Memory', MEMORY_KB_SLUG)
    if (!kb?.id) return null
    memoryKbCache.set(targetId, kb.id)
    return kb.id
  } catch {
    return null
  }
}

async function resolveContext(): Promise<CloudContext | null> {
  const acct = await resolveAccount()
  if (!acct) return null
  const kbId = await discoverMemoryKb(acct.targetId, acct.apiBase, acct.apiKey)
  if (!kbId) return null
  return { apiBase: acct.apiBase, apiKey: acct.apiKey, kbId }
}

/** Drop the discovered-KB cache (e.g. on logout / account change). */
export function resetMemoryKbCache(): void {
  memoryKbCache.clear()
}

/** Resolve {apiBase, apiKey, kbId} for the shared memory KB — used by binding sync. */
export { resolveContext as resolveMemoryContext }

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

/** True when sync is enabled and a Picora account is selected (KB auto-discovered). */
export async function isConfigured(): Promise<boolean> {
  const cfg = await store.getCloudConfig()
  return cfg.enabled && !!cfg.targetId
}
