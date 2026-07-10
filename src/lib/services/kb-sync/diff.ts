// The three-way diff engine now lives in @moraya/core/sync (extracted in
// core v0.8.0 so PC / Web / Mobile share one decision table). This module is a
// thin re-export shim so every existing `./diff` import — sync-service, the
// conflict panel, diff.test.ts — keeps working unchanged; diff.test.ts thereby
// exercises the core implementation, acting as a PC↔core equivalence check.
export { threeWayDiff } from '@moraya/core/sync';
export type { InitialAuthority } from '@moraya/core/sync';
