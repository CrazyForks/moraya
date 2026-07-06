/**
 * PC memory runtime — orchestrates the store + pure logic into the live service
 * used by the chat pipeline (injection, /memorize) and the settings page.
 *
 * Local-only by default; each content-level write also mirrors to Picora when
 * cloud sync is configured (see `./cloud-sync`, invoked via dynamic import to
 * avoid a static cycle).
 */
import type { MemoryDoc, MemoryKind, MemoryHalfLife, SensitivityLevel, FactType } from './types'
import { MEMORY_CONTENT_MAX_LEN } from './types'
import * as store from './store'
import { parseMemorizeCommand, buildExplicitMemoryDoc } from './explicit'
import { buildInjection } from './inject'

function uuid(): string {
  return crypto.randomUUID()
}

// ── Chat integration ────────────────────────────────────────────────────────

/**
 * Build the system-prompt fragment for a chat turn. Best-effort: returns ''
 * when memory is empty/unavailable. Touches lastUsedAt on injected memories.
 */
export async function buildChatMemoryContext(query: string): Promise<string> {
  try {
    const docs = await store.getAll()
    if (docs.length === 0) return ''
    const now = new Date()
    const halfLife = await store.getHalfLife()
    const { fragment, usedMemoryIds } = buildInjection(docs, query, now, halfLife)
    if (fragment) void touch(usedMemoryIds, now)
    return fragment
  } catch {
    return ''
  }
}

async function touch(ids: string[], now: Date): Promise<void> {
  try {
    const iso = now.toISOString()
    for (const id of ids) {
      const doc = await store.getById(id)
      if (doc) await store.put({ ...doc, lastUsedAt: iso })
    }
  } catch { /* advisory only */ }
}

/**
 * Handle a chat input that may be `/memorize …`. Persists and returns the doc,
 * or null if the input isn't a memorize command.
 */
export async function memorizeFromInput(text: string): Promise<MemoryDoc | null> {
  const parsed = parseMemorizeCommand(text)
  if (!parsed) return null
  const doc = buildExplicitMemoryDoc(parsed, new Date(), uuid())
  await store.put(doc)
  schedulePush(doc)
  return doc
}

// ── Programmatic write ──────────────────────────────────────────────────────

export interface WriteMemoryInput {
  content: string
  kind: MemoryKind
  sensitivity?: SensitivityLevel
  weight?: number
  sources?: string[]
  domain?: string
  projectName?: string
  factType?: FactType
}

export async function writeMemory(input: WriteMemoryInput): Promise<MemoryDoc> {
  const iso = new Date().toISOString()
  const doc: MemoryDoc = {
    id: uuid(),
    kind: input.kind,
    content: input.content.slice(0, MEMORY_CONTENT_MAX_LEN),
    weight: input.weight ?? 1.0,
    sensitivity: input.sensitivity ?? 'low',
    status: 'active',
    createdAt: iso,
    lastUsedAt: iso,
    sources: input.sources ?? [],
    preference: input.kind === 'preference' ? { domain: input.domain ?? 'general' } : undefined,
    project: input.kind === 'project' && input.projectName ? { projectName: input.projectName } : undefined,
    fact: input.kind === 'fact' ? { factType: input.factType ?? 'other' } : undefined,
  }
  await store.put(doc)
  schedulePush(doc)
  return doc
}

// ── Settings-page operations ────────────────────────────────────────────────

export async function updateMemoryContent(id: string, content: string): Promise<MemoryDoc | null> {
  const doc = await store.getById(id)
  if (!doc) return null
  const updated: MemoryDoc = { ...doc, content: content.slice(0, MEMORY_CONTENT_MAX_LEN) }
  await store.put(updated)
  schedulePush(updated)
  return updated
}

export async function deleteMemory(id: string): Promise<void> {
  await store.softDelete(id)
  scheduleDelete(id)
}

export async function toggleMemory(doc: MemoryDoc): Promise<MemoryDoc['status']> {
  const next: MemoryDoc['status'] = doc.status === 'active' ? 'deleted' : 'active'
  await store.setStatus(doc.id, next)
  const updated = await store.getById(doc.id)
  if (updated) schedulePush(updated)
  return next
}

export async function resetAllMemories(): Promise<void> {
  await store.hardDeleteAll()
  scheduleClearCloud()
}

export const listMemories = store.getAll
export const getHalfLife = store.getHalfLife
export async function setHalfLife(v: MemoryHalfLife): Promise<void> {
  await store.setHalfLife(v)
}

// ── Cloud push hooks (best-effort, dynamic import breaks the cycle) ──────────

let cloudPushEnabled = true

/** Disable cloud side effects (unit tests). */
export function _setCloudPushEnabled(on: boolean): void {
  cloudPushEnabled = on
}

function schedulePush(doc: MemoryDoc): void {
  if (!cloudPushEnabled) return
  void (async () => {
    try {
      const m = await import('./cloud-sync')
      await m.pushMemory(doc)
    } catch { /* best-effort */ }
  })()
}

function scheduleDelete(id: string): void {
  if (!cloudPushEnabled) return
  void (async () => {
    try {
      const m = await import('./cloud-sync')
      await m.deleteRemoteMemory(id)
    } catch { /* best-effort */ }
  })()
}

function scheduleClearCloud(): void {
  if (!cloudPushEnabled) return
  void (async () => {
    try {
      const m = await import('./cloud-sync')
      await m.clearRemoteMemories()
    } catch { /* best-effort */ }
  })()
}
