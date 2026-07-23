/**
 * Base-content cache — the "merge base" (common ancestor) for KB sync.
 *
 * The manifest only stores hashes, which is enough to DETECT divergence but not
 * enough to MERGE it. To do a git-style 3-way merge we need the actual content
 * of the last-synced version. This module persists that content per file under
 * `~/.moraya/kb-sync/{localKbId}/base/{relativePath}` and reads it back when a
 * conflict needs merging.
 *
 * Writes happen after every successful upload/download so the base tracks the
 * last agreed state. Reads are best-effort: a missing base (first sync, or a
 * file synced before this cache existed) simply means the merge falls back to
 * 2-way. Path safety is enforced Rust-side by `validate_path` on read/write_file
 * plus the `$HOME/.moraya/**` scope; we additionally reject `..` segments here.
 */
import { invoke } from '@tauri-apps/api/core';
import { homeDir } from '@tauri-apps/api/path';

function baseRoot(localKbId: string, home: string): string {
  return `${home}/.moraya/kb-sync/${localKbId}/base`;
}

/** Reject relative paths that could escape the base dir. */
function isSafeRelPath(relativePath: string): boolean {
  if (!relativePath || relativePath.startsWith('/')) return false;
  return !relativePath.split('/').some((seg) => seg === '..' || seg === '');
}

export async function saveBaseContent(
  localKbId: string,
  relativePath: string,
  content: string,
): Promise<void> {
  if (!isSafeRelPath(relativePath)) return;
  try {
    const home = await homeDir();
    const path = `${baseRoot(localKbId, home)}/${relativePath}`;
    await invoke('write_file', { path, content });
  } catch {
    // best-effort; a failed base write just degrades a future merge to 2-way
  }
}

export async function loadBaseContent(
  localKbId: string,
  relativePath: string,
): Promise<string | null> {
  if (!isSafeRelPath(relativePath)) return null;
  try {
    const home = await homeDir();
    const path = `${baseRoot(localKbId, home)}/${relativePath}`;
    return await invoke<string>('read_file', { path });
  } catch {
    return null;
  }
}

export async function deleteBaseContent(
  localKbId: string,
  relativePath: string,
): Promise<void> {
  if (!isSafeRelPath(relativePath)) return;
  try {
    const home = await homeDir();
    const path = `${baseRoot(localKbId, home)}/${relativePath}`;
    await invoke('delete_file', { path });
  } catch {
    // best-effort
  }
}
// (loadBaseContent already guards homeDir inside its try/catch)
