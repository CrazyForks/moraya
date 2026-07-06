/**
 * PC long-term memory types.
 *
 * The canonical entry type is `MemoryDoc` from `@moraya/core/memory` — the same
 * platform-agnostic contract web/mobile sync to Picora's dot-directory hosting.
 * PC stores `MemoryDoc[]` directly in a Tauri plugin-store file (ISO-string
 * dates serialize cleanly as JSON). Unlike web, PC carries no embeddings; memory
 * ranking uses decay-weight + substring matching.
 */
import type {
  MemoryDoc,
  MemoryKind,
  MemoryStatus,
  SensitivityLevel,
  FactType,
} from '@moraya/core/memory'

export type { MemoryDoc, MemoryKind, MemoryStatus, SensitivityLevel, FactType }

/** Memory half-life in days, or 'never' (no time decay). */
export type MemoryHalfLife = 30 | 90 | 180 | 'never'

export const DEFAULT_HALF_LIFE: MemoryHalfLife = 90
export const MEMORY_MAX_COUNT = 1000
export const MEMORY_CONTENT_MAX_LEN = 200
export const INJECT_TOP_K = 5
export const INJECT_TOKEN_LIMIT = 1000
export const MEMORY_CLEANUP_WEIGHT_THRESHOLD = 0.1

// ── Health report ─────────────────────────────────────────────────────────

export interface HealthIssue {
  type: 'stale' | 'duplicate' | 'conflict' | 'capacity'
  memoryIds: string[]
  /** Placeholder values for the localized `memory.health_<type>` message. */
  params: Record<string, number>
}

export interface HealthReport {
  total: number
  active: number
  deleted: number
  conflict: number
  staleCount: number
  duplicateCount: number
  usagePercent: number
  issues: HealthIssue[]
}
