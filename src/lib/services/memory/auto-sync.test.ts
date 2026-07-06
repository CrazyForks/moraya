import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Keep the module singleton's real deps out of the unit under test.
vi.mock('./cloud-sync', () => ({ isConfigured: async () => false, syncNow: async () => ({ pulled: 0, pushed: 0 }) }))
vi.mock('./binding-sync', () => ({ syncAllBindings: async () => ({ pushed: 0, skipped: 0 }) }))

import { createMemoryAutoSync } from './auto-sync'

describe('createMemoryAutoSync', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

  it('debounces multiple triggers into one sync', async () => {
    const sync = vi.fn(async () => {})
    const s = createMemoryAutoSync({ sync, isEnabled: async () => true, debounceMs: 100, intervalMs: 10_000 })
    s.trigger(); s.trigger(); s.trigger()
    expect(sync).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(sync).toHaveBeenCalledTimes(1)
    s.stop()
  })

  it('does not sync when disabled', async () => {
    const sync = vi.fn(async () => {})
    const s = createMemoryAutoSync({ sync, isEnabled: async () => false, debounceMs: 50, intervalMs: 10_000 })
    s.trigger()
    await vi.advanceTimersByTimeAsync(50)
    expect(sync).not.toHaveBeenCalled()
    s.stop()
  })

  it('runs on interval after start', async () => {
    const sync = vi.fn(async () => {})
    const s = createMemoryAutoSync({ sync, isEnabled: async () => true, debounceMs: 10, intervalMs: 1_000 })
    s.start()
    await vi.advanceTimersByTimeAsync(10) // initial trigger's debounce
    expect(sync).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000 + 10) // one interval + debounce
    expect(sync).toHaveBeenCalledTimes(2)
    s.stop()
  })

  it('stop() cancels pending + interval', async () => {
    const sync = vi.fn(async () => {})
    const s = createMemoryAutoSync({ sync, isEnabled: async () => true, debounceMs: 100, intervalMs: 1_000 })
    s.start()
    s.stop()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sync).not.toHaveBeenCalled()
  })

  it('does not overlap runs (guards re-entry)', async () => {
    let active = 0
    let maxActive = 0
    const sync = vi.fn(async () => {
      active++; maxActive = Math.max(maxActive, active)
      await new Promise(r => setTimeout(r, 500))
      active--
    })
    const s = createMemoryAutoSync({ sync, isEnabled: async () => true, debounceMs: 10, intervalMs: 100 })
    s.start()
    await vi.advanceTimersByTimeAsync(400) // several interval ticks while first run is in-flight
    expect(maxActive).toBe(1)
    s.stop()
    await vi.advanceTimersByTimeAsync(600)
  })
})
