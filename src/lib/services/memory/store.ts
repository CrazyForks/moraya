/**
 * PC memory persistence — a single Tauri plugin-store file `memory.json`
 * holding the full `MemoryDoc[]` plus a `halfLife` setting. Mirrors the
 * mcp-config / knowledge-bases single-file-array pattern.
 *
 * The disk layer is injected via `setMemoryPersistence` so unit tests run
 * without a Tauri runtime; production wires the plugin-store adapter lazily.
 */
import type { MemoryDoc, MemoryHalfLife } from './types'
import { DEFAULT_HALF_LIFE } from './types'
import type { MemoryBinding } from './tool-profiles'

const MEMORY_STORE_FILE = 'memory.json'
const KEY_MEMORIES = 'memories'
const KEY_HALF_LIFE = 'halfLife'
const KEY_CLOUD = 'cloud'
const KEY_BINDINGS = 'bindings'

export interface MemoryPersistence {
  read<T>(key: string): Promise<T | null>
  write(key: string, value: unknown): Promise<void>
}

// Default (production) adapter: Tauri plugin-store, imported lazily so this
// module stays importable in non-Tauri contexts (tests, SSR-less checks).
const tauriPersistence: MemoryPersistence = {
  async read<T>(key: string): Promise<T | null> {
    const { load } = await import('@tauri-apps/plugin-store')
    const store = await load(MEMORY_STORE_FILE)
    return (await store.get<T>(key)) ?? null
  },
  async write(key: string, value: unknown): Promise<void> {
    const { load } = await import('@tauri-apps/plugin-store')
    const store = await load(MEMORY_STORE_FILE)
    await store.set(key, value)
    await store.save()
  },
}

let persistence: MemoryPersistence = tauriPersistence

/** Override the disk layer (tests). Pass null to restore the Tauri adapter. */
export function setMemoryPersistence(p: MemoryPersistence | null): void {
  persistence = p ?? tauriPersistence
}

// In-memory cache so reads are synchronous-fast after first load; disk is the
// source of truth on write.
let cache: MemoryDoc[] | null = null

export async function loadMemories(): Promise<MemoryDoc[]> {
  if (cache) return cache
  const docs = (await persistence.read<MemoryDoc[]>(KEY_MEMORIES)) ?? []
  cache = Array.isArray(docs) ? docs : []
  return cache
}

async function persist(docs: MemoryDoc[]): Promise<void> {
  cache = docs
  await persistence.write(KEY_MEMORIES, docs)
}

export async function getAll(includeDeleted = false): Promise<MemoryDoc[]> {
  const docs = await loadMemories()
  return includeDeleted ? [...docs] : docs.filter(d => d.status !== 'deleted')
}

export async function getById(id: string): Promise<MemoryDoc | null> {
  const docs = await loadMemories()
  return docs.find(d => d.id === id) ?? null
}

/** Insert or replace a memory by id. */
export async function put(doc: MemoryDoc): Promise<void> {
  const docs = await loadMemories()
  const idx = docs.findIndex(d => d.id === doc.id)
  if (idx >= 0) docs[idx] = doc
  else docs.push(doc)
  await persist([...docs])
}

export async function softDelete(id: string): Promise<void> {
  const doc = await getById(id)
  if (!doc) return
  await put({ ...doc, status: 'deleted', weight: 0 })
}

export async function setStatus(id: string, status: MemoryDoc['status']): Promise<void> {
  const doc = await getById(id)
  if (!doc) return
  await put({ ...doc, status })
}

export async function hardDeleteAll(): Promise<void> {
  await persist([])
}

export async function count(activeOnly = false): Promise<number> {
  return (await getAll(activeOnly)).length
}

// ── Half-life setting (stored alongside memories) ───────────────────────────

export async function getHalfLife(): Promise<MemoryHalfLife> {
  const v = await persistence.read<MemoryHalfLife>(KEY_HALF_LIFE)
  if (v === 'never' || v === 30 || v === 90 || v === 180) return v
  return DEFAULT_HALF_LIFE
}

export async function setHalfLife(value: MemoryHalfLife): Promise<void> {
  await persistence.write(KEY_HALF_LIFE, value)
}

// ── Cloud-sync config (which Picora account + KB memories mirror to) ─────────

export interface MemoryCloudConfig {
  enabled: boolean
  /**
   * id of an `imageHostTargets` entry that is Picora-connected. The KB itself
   * is not stored here — memories always go to the account's shared "AI Memory"
   * KB (slug='memory'), auto-discovered by the sync layer.
   */
  targetId: string | null
}

const DEFAULT_CLOUD_CONFIG: MemoryCloudConfig = { enabled: false, targetId: null }

export async function getCloudConfig(): Promise<MemoryCloudConfig> {
  const v = await persistence.read<MemoryCloudConfig>(KEY_CLOUD)
  return v ? { ...DEFAULT_CLOUD_CONFIG, ...v } : { ...DEFAULT_CLOUD_CONFIG }
}

export async function setCloudConfig(config: MemoryCloudConfig): Promise<void> {
  await persistence.write(KEY_CLOUD, config)
}

// ── Tool-memory binding table (client-local, contains machine paths) ────────

export async function getBindings(): Promise<MemoryBinding[]> {
  const v = await persistence.read<MemoryBinding[]>(KEY_BINDINGS)
  return Array.isArray(v) ? v : []
}

export async function setBindings(bindings: MemoryBinding[]): Promise<void> {
  await persistence.write(KEY_BINDINGS, bindings)
}

/** Test helper: drop the in-memory cache. */
export function _resetCache(): void {
  cache = null
}
