/**
 * Memory health check (ported from web `src/lib/memory/health.ts`).
 * Issues carry structured `params` — the UI maps `type` → `memory.health_<type>`
 * i18n key and interpolates, so no English copy lives in this logic layer.
 */
import type { MemoryDoc, MemoryHalfLife, HealthReport, HealthIssue } from './types'
import { MEMORY_CLEANUP_WEIGHT_THRESHOLD, MEMORY_MAX_COUNT } from './types'
import { isStale } from './decay'
import { overlapScore, contentHash } from './conflict'

export interface HealthCheckOptions {
  now?: Date
  halfLife?: MemoryHalfLife
  staleThreshold?: number
  duplicateOverlapThreshold?: number
}

export function runHealthCheck(docs: MemoryDoc[], options: HealthCheckOptions = {}): HealthReport {
  const {
    now = new Date(),
    halfLife = 90,
    staleThreshold = MEMORY_CLEANUP_WEIGHT_THRESHOLD,
    duplicateOverlapThreshold = 0.85,
  } = options

  const active = docs.filter(d => d.status === 'active')
  const deleted = docs.filter(d => d.status === 'deleted')
  const conflict = docs.filter(d => d.status === 'conflict')
  const issues: HealthIssue[] = []

  const stale = active.filter(d => isStale(d, now, halfLife, staleThreshold))
  if (stale.length > 0) issues.push({ type: 'stale', memoryIds: stale.map(d => d.id), params: { n: stale.length } })

  // Exact-hash + semantic near-duplicate pairs.
  const seen = new Map<string, MemoryDoc>()
  const dupPairs: Array<[string, string]> = []
  for (const d of active) {
    const h = contentHash(d.content)
    const prev = seen.get(h)
    if (prev) dupPairs.push([prev.id, d.id])
    else seen.set(h, d)
  }
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      if (overlapScore(active[i]!.content, active[j]!.content) >= duplicateOverlapThreshold) {
        const exists = dupPairs.find(([a, b]) => a === active[i]!.id || b === active[j]!.id)
        if (!exists) dupPairs.push([active[i]!.id, active[j]!.id])
      }
    }
  }
  if (dupPairs.length > 0) {
    issues.push({ type: 'duplicate', memoryIds: [...new Set(dupPairs.flat())], params: { n: dupPairs.length } })
  }

  if (conflict.length > 0) {
    issues.push({ type: 'conflict', memoryIds: conflict.map(d => d.id), params: { n: conflict.length } })
  }

  const usagePercent = (active.length / MEMORY_MAX_COUNT) * 100
  if (usagePercent >= 80) {
    issues.push({
      type: 'capacity',
      memoryIds: [],
      params: { pct: Math.round(usagePercent), active: active.length, max: MEMORY_MAX_COUNT },
    })
  }

  return {
    total: docs.length,
    active: active.length,
    deleted: deleted.length,
    conflict: conflict.length,
    staleCount: stale.length,
    duplicateCount: dupPairs.length,
    usagePercent,
    issues,
  }
}

export function isHealthy(report: HealthReport): boolean {
  return report.issues.length === 0
}
