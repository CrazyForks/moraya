/**
 * Tool-memory binding management (client-local table).
 *
 * A binding maps an external tool memory dir (e.g. `~/.claude`) into a KB
 * namespace (`.claude/`). Bindings are keyed by `mountAs` (one per namespace).
 * Hard-excludes always come from the tool profile, so re-adding refreshes them.
 */
import type { MemoryBinding } from './tool-profiles'
import { getToolProfile, bindingFromProfile } from './tool-profiles'
import * as store from './store'

export async function listBindings(): Promise<MemoryBinding[]> {
  return store.getBindings()
}

/**
 * Add (or refresh) a binding for a known tool profile. Returns the binding, or
 * null if the tool has no profile. Idempotent by `mountAs`.
 */
export async function addToolBinding(tool: string, externalPath?: string): Promise<MemoryBinding | null> {
  const profile = getToolProfile(tool)
  if (!profile) return null
  const binding = bindingFromProfile(profile, externalPath)
  const existing = await store.getBindings()
  const next = existing.filter(b => b.mountAs !== binding.mountAs)
  next.push(binding)
  await store.setBindings(next)
  return binding
}

export async function removeBinding(mountAs: string): Promise<void> {
  const existing = await store.getBindings()
  await store.setBindings(existing.filter(b => b.mountAs !== mountAs))
}

export async function hasBinding(mountAs: string): Promise<boolean> {
  return (await store.getBindings()).some(b => b.mountAs === mountAs)
}
