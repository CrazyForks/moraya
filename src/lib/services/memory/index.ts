/**
 * PC long-term memory service — barrel export.
 */
export type {
  MemoryDoc,
  MemoryKind,
  MemoryStatus,
  SensitivityLevel,
  FactType,
  MemoryHalfLife,
  HealthReport,
  HealthIssue,
} from './types'
export {
  DEFAULT_HALF_LIFE,
  MEMORY_MAX_COUNT,
  MEMORY_CONTENT_MAX_LEN,
} from './types'

export { effectiveWeight, isStale, HALF_LIFE_OPTIONS } from './decay'
export { parseMemorizeCommand, buildExplicitMemoryDoc } from './explicit'
export { overlapScore, contentHash, tokenize } from './conflict'
export { rankMemories, selectTopK, formatInjection, buildInjection } from './inject'
export { runHealthCheck, isHealthy } from './health'

export * as memoryStore from './store'
export type { MemoryCloudConfig, MemoryPersistence } from './store'

export {
  buildChatMemoryContext,
  memorizeFromInput,
  writeMemory,
  updateMemoryContent,
  deleteMemory,
  toggleMemory,
  resetAllMemories,
  listMemories,
  getHalfLife,
  setHalfLife,
} from './runtime'
export type { WriteMemoryInput } from './runtime'

export {
  memorySyncStatus,
  type MemorySyncStatusKind,
  pushMemory,
  deleteRemoteMemory,
  clearRemoteMemories,
  syncNow,
  isConfigured,
} from './cloud-sync'
