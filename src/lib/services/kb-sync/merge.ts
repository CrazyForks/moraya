// The line-level merge engine now lives in @moraya/core/sync (extracted in
// core v0.8.0). This module is a thin re-export shim so every existing
// `./merge` import — sync-service, KbSyncConflictPanel, merge.test.ts — keeps
// working unchanged and exercises the shared core implementation.
export {
  splitLines,
  joinLines,
  threeWayMergeLines,
  twoWayMergeLines,
  assembleMerged,
  conflictChunkCount,
} from '@moraya/core/sync';
