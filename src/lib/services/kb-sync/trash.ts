/**
 * KB sync trash (recycle bin) front-end client — v0.68.0.
 *
 * Wraps three Rust commands:
 *   - kb_sync_list_trash       (browse)
 *   - kb_sync_restore_from_trash (recover)
 *   - kb_sync_purge_trash      (hard-delete old entries / "empty bin")
 *
 * Filesystem layout (authoritative; see kb_sync.rs):
 *   ~/.moraya/trash/{kbId}/{ts}/{relativePath}
 *
 * The {ts} segment is a filename-safe RFC3339 string written by manifest.ts
 * at delete time (`:` replaced with `-`). The Rust side parses it back to
 * epoch ms for sorting and purging.
 */

import { invoke } from '@tauri-apps/api/core';

export interface TrashEntry {
  kbId: string;
  /** Filename-safe timestamp segment (folder name under {kbId}/). */
  deletedAt: string;
  /** Epoch milliseconds parsed from `deletedAt`; 0 if unparseable. */
  deletedAtMs: number;
  relativePath: string;
  sizeBytes: number;
  absoluteTrashPath: string;
}

export type RestoreResult =
  | { kind: 'restored'; targetPath: string }
  | { kind: 'conflict-exists'; existingSize: number };

export interface PurgeReport {
  purgedFiles: number;
  purgedDirs: number;
  freedBytes: number;
}

export async function listTrash(kbId?: string, limit?: number): Promise<TrashEntry[]> {
  return invoke<TrashEntry[]>('kb_sync_list_trash', {
    kbId: kbId ?? null,
    limit: limit ?? null,
  });
}

export async function restoreFromTrash(opts: {
  kbId: string;
  deletedAt: string;
  relativePath: string;
  kbRoot: string;
  overwrite?: boolean;
}): Promise<RestoreResult> {
  return invoke<RestoreResult>('kb_sync_restore_from_trash', {
    kbId: opts.kbId,
    deletedAt: opts.deletedAt,
    relativePath: opts.relativePath,
    kbRoot: opts.kbRoot,
    overwrite: opts.overwrite ?? false,
  });
}

export async function purgeTrash(opts?: {
  kbId?: string;
  olderThanDays?: number;
}): Promise<PurgeReport> {
  return invoke<PurgeReport>('kb_sync_purge_trash', {
    kbId: opts?.kbId ?? null,
    olderThanDays: opts?.olderThanDays ?? null,
  });
}

/**
 * Hard-delete a single trash entry by absolute path. Wraps the generic
 * `delete_file` Tauri command so consumers stay above the IPC boundary.
 */
export async function deleteTrashEntry(absoluteTrashPath: string): Promise<void> {
  await invoke('delete_file', { path: absoluteTrashPath });
}

/** Group entries by kbId, preserving sort order within each group. */
export function groupByKb(entries: TrashEntry[]): Map<string, TrashEntry[]> {
  const out = new Map<string, TrashEntry[]>();
  for (const e of entries) {
    const list = out.get(e.kbId);
    if (list) list.push(e);
    else out.set(e.kbId, [e]);
  }
  return out;
}

/** Filter to entries deleted at or after the given epoch ms. */
export function filterSince(entries: TrashEntry[], sinceMs: number): TrashEntry[] {
  return entries.filter(e => e.deletedAtMs >= sinceMs);
}

/** Human-readable byte size. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
