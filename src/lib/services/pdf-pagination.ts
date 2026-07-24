// The page-break solver now lives in @moraya/core/export (extracted in core
// v0.11.0 so PC / Web / Mobile share one pagination semantics). This module is a
// thin re-export shim so existing `./pdf-pagination` imports — and
// pdf-pagination.test.ts — keep working unchanged and exercise the shared core
// implementation.
export { computeBreakOffsets } from '@moraya/core/export';
export type { BlockExtent } from '@moraya/core/export';
