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
  MEMORY_KB_SLUG,
  pushMemory,
  deleteRemoteMemory,
  clearRemoteMemories,
  syncNow,
  isConfigured,
  resetMemoryKbCache,
} from './cloud-sync'

// Tool-memory bindings (P2)
export {
  TOOL_PROFILES,
  getToolProfile,
  bindingFromProfile,
  includedByProfile,
  globToRegExp,
  type ToolProfile,
  type MemoryBinding,
} from './tool-profiles'
export { listBindings, addToolBinding, removeBinding, hasBinding } from './bindings'
export { syncBinding, syncAllBindings, restoreBinding, toolDirPresent, moveBindingToDedicatedKb } from './binding-sync'
export { createMemoryAutoSync, startMemoryAutoSync, stopMemoryAutoSync, type MemoryAutoSync } from './auto-sync'
export { mergeMemoryFile, unionMergeLines, isIndexFile, type MemoryMergeOutcome } from './memory-merge'
