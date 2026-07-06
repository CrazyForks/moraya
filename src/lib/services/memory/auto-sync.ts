/**
 * Memory auto-sync scheduler (P2c).
 *
 * The design (§8.4) prefers fs-events for change detection, but watching
 * arbitrary home dirs (`~/.claude`) would require an fs:scope-home capability,
 * which the project security rules forbid. So this is the sanctioned fallback:
 * a debounced auto-sync triggered on window focus + a periodic interval. Each
 * trigger runs the memory pull/push and all tool-binding pushes, but only when
 * cloud sync is actually configured.
 *
 * `createMemoryAutoSync` is dependency-injected for tests; the module singleton
 * wires the real sync + gate.
 */
import { isConfigured, syncNow } from './cloud-sync'
import { syncAllBindings } from './binding-sync'

export interface MemoryAutoSyncOptions {
  intervalMs?: number
  debounceMs?: number
  /** Runs a full sync pass. */
  sync: () => Promise<void>
  /** Gate — sync only fires when this resolves true. */
  isEnabled: () => Promise<boolean>
}

export interface MemoryAutoSync {
  start(): void
  stop(): void
  /** Request a (debounced) sync. */
  trigger(): void
}

export function createMemoryAutoSync(opts: MemoryAutoSyncOptions): MemoryAutoSync {
  const intervalMs = opts.intervalMs ?? 5 * 60_000
  const debounceMs = opts.debounceMs ?? 2_000
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let intervalTimer: ReturnType<typeof setInterval> | null = null
  let onFocus: (() => void) | null = null
  let running = false

  async function run(): Promise<void> {
    if (running) return
    if (!(await opts.isEnabled())) return
    running = true
    try {
      await opts.sync()
    } catch {
      /* best-effort */
    } finally {
      running = false
    }
  }

  function trigger(): void {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => { debounceTimer = null; void run() }, debounceMs)
  }

  function start(): void {
    if (intervalTimer) return // already started
    intervalTimer = setInterval(trigger, intervalMs)
    if (typeof window !== 'undefined') {
      onFocus = () => trigger()
      window.addEventListener('focus', onFocus)
    }
    trigger() // initial pass shortly after start
  }

  function stop(): void {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
    if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null }
    if (onFocus && typeof window !== 'undefined') { window.removeEventListener('focus', onFocus); onFocus = null }
  }

  return { start, stop, trigger }
}

// ── Module singleton (real wiring) ──────────────────────────────────────────

async function defaultSync(): Promise<void> {
  await syncNow()          // Moraya's own memory (.moraya) pull/push
  await syncAllBindings()  // external tool bindings (push-only)
}

let instance: MemoryAutoSync | null = null

/** Start app-wide memory auto-sync (idempotent). No-op outside a browser. */
export function startMemoryAutoSync(): void {
  if (instance || typeof window === 'undefined') return
  instance = createMemoryAutoSync({ sync: defaultSync, isEnabled: isConfigured })
  instance.start()
}

export function stopMemoryAutoSync(): void {
  instance?.stop()
  instance = null
}
