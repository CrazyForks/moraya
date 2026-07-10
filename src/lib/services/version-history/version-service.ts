import { invoke } from '@tauri-apps/api/core';
import { filesStore } from '$lib/stores/files-store';
import { settingsStore } from '$lib/stores/settings-store';

/**
 * Local per-document version history (v1.21.0).
 *
 * Snapshots live under `{kbRoot}/.versions/{relativePath}/` — one directory per
 * document, holding timestamped snapshot files plus a `meta.json` index. The
 * `.versions` top-level dot-directory is invisible to the sidebar file tree
 * (Rust `read_dir_inner` skips dot-prefixed children) and excluded from KB
 * cloud folder sync (`isMemoryNamespacePath` filters every top-level dot dir
 * except `.moraya`), so snapshots stay local with zero extra ignore rules.
 *
 * The schema mirrors Picora's server-side `doc_revisions` semantics
 * (rev_number / source_hash / size_bytes / origin) so a later cloud-sync phase
 * maps 1:1; `remote` is reserved for that phase and always undefined today.
 */

export type VersionOrigin = 'manual' | 'auto' | 'restore';

export interface VersionEntry {
  revNumber: number;
  file: string;
  sourceHash: string;
  sizeBytes: number;
  origin: VersionOrigin;
  createdAt: string;
  /** Reserved for the Picora doc_revisions sync phase (drives the "P" badge). */
  remote?: { revId: string; syncedAt: string };
}

export interface VersionMeta {
  nextRevNumber: number;
  /** Newest first. */
  entries: VersionEntry[];
}

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

const META_FILE = 'meta.json';
const MAX_VERSIONS_CAP = 500;

/** SHA-256 hex of a UTF-8 string — same digest as kb-sync's local hash, so a
 *  future cloud phase can compare directly against Picora's source_hash. */
export async function sha256Hex(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Relative path of a file inside a KB root, or null if outside it. */
export function relativePathFor(kbRoot: string, filePath: string): string | null {
  const root = kbRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const file = filePath.replace(/\\/g, '/');
  if (!file.startsWith(root + '/')) return null;
  const rel = file.slice(root.length + 1);
  return rel.length > 0 ? rel : null;
}

/** Snapshot directory for one document. */
export function versionsDirFor(kbRoot: string, relativePath: string): string {
  const root = kbRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  return `${root}/.versions/${relativePath}`;
}

/** Timestamped snapshot filename; the rev suffix guarantees uniqueness for
 *  multiple snapshots within the same second. */
export function snapshotFileName(revNumber: number, now: Date): string {
  const ts = now.toISOString().replace(/:/g, '-').replace('T', '_').slice(0, 19);
  return `${ts}_r${revNumber}.md`;
}

/** Split a meta into the retained head and the pruned tail (beyond `max`). */
export function pruneEntries(
  meta: VersionMeta,
  max: number
): { meta: VersionMeta; removed: VersionEntry[] } {
  const cap = Math.max(1, Math.min(MAX_VERSIONS_CAP, Math.floor(max)));
  if (meta.entries.length <= cap) return { meta, removed: [] };
  return {
    meta: { nextRevNumber: meta.nextRevNumber, entries: meta.entries.slice(0, cap) },
    removed: meta.entries.slice(cap),
  };
}

/** Recover a usable meta from a bare snapshot-file listing (meta.json lost or
 *  corrupt). Rev numbers are re-assigned oldest→newest by filename order;
 *  hashes/sizes are unknown (blank hash simply skips the next dedupe check). */
export function rebuildMetaFromFiles(fileNames: string[]): VersionMeta {
  const snaps = fileNames
    .filter((n) => n.endsWith('.md'))
    .sort((a, b) => a.localeCompare(b)); // oldest first
  const entries: VersionEntry[] = snaps.map((file, i) => ({
    revNumber: i + 1,
    file,
    sourceHash: '',
    sizeBytes: 0,
    origin: 'auto' as const,
    createdAt: timestampFromFileName(file) ?? '',
  }));
  entries.reverse(); // newest first
  return { nextRevNumber: snaps.length + 1, entries };
}

/** Parse `2026-07-10_14-30-45(_rN).md` back into an ISO timestamp. */
function timestampFromFileName(file: string): string | null {
  const m = file.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return `${m[1]}T${m[2]}:${m[3]}:${m[4]}`;
}

function isValidMeta(v: unknown): v is VersionMeta {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as VersionMeta;
  return typeof m.nextRevNumber === 'number' && Array.isArray(m.entries);
}

async function loadMeta(dir: string): Promise<VersionMeta> {
  try {
    const raw = await invoke<string>('read_file', { path: `${dir}/${META_FILE}` });
    const parsed = JSON.parse(raw) as unknown;
    if (isValidMeta(parsed)) return parsed;
  } catch {
    // missing or unreadable — fall through to rebuild
  }
  try {
    const entries = await invoke<FileEntry[]>('read_dir_recursive', { path: dir, depth: 1 });
    const files = entries.filter((e) => !e.is_dir && e.name !== META_FILE).map((e) => e.name);
    if (files.length > 0) return rebuildMetaFromFiles(files);
  } catch {
    // dir doesn't exist yet — brand-new document
  }
  return { nextRevNumber: 1, entries: [] };
}

async function saveMeta(dir: string, meta: VersionMeta): Promise<void> {
  await invoke('write_file', {
    path: `${dir}/${META_FILE}`,
    content: JSON.stringify(meta, null, 2),
  });
}

function resolveVersionsDir(filePath: string): string | null {
  const kb = filesStore.findKnowledgeBaseForFile(filePath);
  if (!kb) return null;
  const rel = relativePathFor(kb.path, filePath);
  if (!rel) return null;
  return versionsDirFor(kb.path, rel);
}

/** Whether the given document participates in version history (inside a KB). */
export function isVersionedPath(filePath: string | null): boolean {
  return !!filePath && resolveVersionsDir(filePath) !== null;
}

async function writeSnapshot(
  dir: string,
  content: string,
  origin: VersionOrigin
): Promise<void> {
  const meta = await loadMeta(dir);
  const hash = await sha256Hex(content);
  if (meta.entries[0]?.sourceHash === hash) return; // unchanged since last snapshot
  const revNumber = meta.nextRevNumber;
  const file = snapshotFileName(revNumber, new Date());
  await invoke('write_file', { path: `${dir}/${file}`, content });
  const entry: VersionEntry = {
    revNumber,
    file,
    sourceHash: hash,
    sizeBytes: utf8Len(content),
    origin,
    createdAt: new Date().toISOString(),
  };
  const next: VersionMeta = { nextRevNumber: revNumber + 1, entries: [entry, ...meta.entries] };
  const max = settingsStore.getState().versionHistoryMax ?? 50;
  const { meta: kept, removed } = pruneEntries(next, max);
  for (const old of removed) {
    await invoke('delete_file', { path: `${dir}/${old.file}` }).catch(() => {});
  }
  await saveMeta(dir, kept);
}

/**
 * Snapshot a document's content into its version history. Best-effort: any
 * failure is swallowed so it can never block the save path. No-ops when the
 * feature is disabled, the document is outside every registered KB, or the
 * content is identical to the latest snapshot.
 */
export async function snapshotVersion(
  filePath: string,
  content: string,
  origin: VersionOrigin
): Promise<void> {
  try {
    if (!settingsStore.getState().versionHistoryEnabled) return;
    const dir = resolveVersionsDir(filePath);
    if (!dir) return;
    await writeSnapshot(dir, content, origin);
  } catch {
    // best-effort — never surface into the save flow
  }
}

/** List a document's versions, newest first. */
export async function listVersions(filePath: string): Promise<VersionEntry[]> {
  const dir = resolveVersionsDir(filePath);
  if (!dir) return [];
  try {
    return (await loadMeta(dir)).entries;
  } catch {
    return [];
  }
}

/** Read one snapshot's content. */
export async function readVersion(filePath: string, entry: VersionEntry): Promise<string> {
  const dir = resolveVersionsDir(filePath);
  if (!dir) throw new Error('not a versioned document');
  return invoke<string>('read_file', { path: `${dir}/${entry.file}` });
}

/**
 * Write arbitrary content into a document as a restore operation. Mirrors
 * Picora's restore semantics: the file's current on-disk content is
 * snapshotted first (origin 'restore', bypassing the enabled flag so nothing
 * is ever lost), then the new content is written. Returns the written
 * content, or null on failure. Also used by the cloud phase to restore a
 * server-side revision's content.
 */
export async function restoreContent(
  filePath: string,
  content: string
): Promise<string | null> {
  const dir = resolveVersionsDir(filePath);
  if (!dir) return null;
  try {
    try {
      const current = await invoke<string>('read_file', { path: filePath });
      await writeSnapshot(dir, current, 'restore');
    } catch {
      // current file unreadable (deleted?) — restore proceeds regardless
    }
    await invoke('write_file', { path: filePath, content });
    return content;
  } catch {
    return null;
  }
}

/**
 * Restore a document to a past local version (see restoreContent for the
 * safety-snapshot semantics). Returns the restored content, or null on failure.
 */
export async function restoreVersion(
  filePath: string,
  entry: VersionEntry
): Promise<string | null> {
  const dir = resolveVersionsDir(filePath);
  if (!dir) return null;
  try {
    const old = await invoke<string>('read_file', { path: `${dir}/${entry.file}` });
    return await restoreContent(filePath, old);
  } catch {
    return null;
  }
}

/** Delete a document's entire version history (the server-side "clear" analog). */
export async function clearVersions(filePath: string): Promise<boolean> {
  const dir = resolveVersionsDir(filePath);
  if (!dir) return false;
  try {
    await invoke('delete_file', { path: dir });
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort: keep a document's history attached across a rename/move. Both
 * paths must land in the same KB; failures leave the old dir orphaned, which
 * is acceptable (it's pruned storage, never user-visible).
 */
export async function renameVersionsDir(oldPath: string, newPath: string): Promise<void> {
  try {
    const oldDir = resolveVersionsDir(oldPath);
    const newDir = resolveVersionsDir(newPath);
    if (!oldDir || !newDir || oldDir === newDir) return;
    await invoke('rename_file', { oldPath: oldDir, newPath: newDir });
  } catch {
    // orphaned history is harmless
  }
}
