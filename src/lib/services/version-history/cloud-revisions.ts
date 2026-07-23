import { invoke } from '@tauri-apps/api/core';
import { filesStore } from '$lib/stores/files-store';
import { settingsStore } from '$lib/stores/settings-store';
import { picoraApiBase, fetchManifest } from '$lib/services/kb-sync/picora-kb-client';
import { getPicoraPlan, isKbSyncEntitled } from '$lib/services/picora/entitlement';
import { relativePathFor, restoreContent, type VersionEntry, type VersionOrigin } from './version-service';
import type { ImageHostTarget } from '$lib/services/image-hosting/types';

/**
 * Cloud layer for document version history (v1.22.0, Picora server v0.74.0).
 *
 * Server-side revisions are produced automatically when KB sync replaces a
 * document's content — nothing here uploads versions. This module:
 *
 *  1. Gates on three conditions (active plan + server-side docVersioning
 *     switch + kbSyncEnabled). Any miss → null → the panel stays local-only.
 *  2. Resolves the server doc id from a FRESH manifest fetch (the server
 *     assigns a new doc id on every content replacement, so a persisted id
 *     would go stale after any upload; revisions re-attach automatically).
 *  3. Matches local snapshots to server revisions by sourceHash (both are
 *     SHA-256 hex over UTF-8) — matched local rows get the "P" badge, and
 *     unmatched server revisions surface as cloud-only rows.
 *  4. Restores a cloud revision by pulling its content and reusing the local
 *     restore semantics (current content snapshotted first). The server-side
 *     restore API is deliberately NOT used — writing locally and letting the
 *     next on-save KB sync upload avoids server doc-id churn and races.
 */

export interface RemoteRevision {
  id: string;
  revNumber: number;
  sizeBytes: number;
  /** Server-side origin enum (differs from the local manual|auto|restore). */
  origin: 'upload' | 'sync' | 'restore';
  sourceHash: string;
  createdAt: string;
}

export interface RemoteRevisionList {
  revisions: RemoteRevision[];
  totalBytes: number;
}

export interface RemoteRevisionsContext {
  apiBase: string;
  apiKey: string;
  docId: string;
  revisions: RemoteRevision[];
  totalBytes: number;
}

export type MergedOrigin = VersionOrigin | 'upload' | 'sync';

/** One row of the merged version list shown in the panel. */
export interface MergedVersionRow extends Omit<VersionEntry, 'origin'> {
  origin: MergedOrigin;
  /** Present on server-backed rows (drives the "P" badge). */
  remote?: { revId: string; syncedAt: string };
  /** True when the version exists only on the server (no local snapshot). */
  cloudOnly?: boolean;
}

function resolveBindingContext(filePath: string): {
  kbPath: string;
  relativePath: string;
  picoraKbId: string;
  target: ImageHostTarget;
} | null {
  const kb = filesStore.findKnowledgeBaseForFile(filePath);
  const binding = kb?.picoraBinding;
  if (!kb || !binding) return null;
  const relativePath = relativePathFor(kb.path, filePath);
  if (!relativePath) return null;
  const target = settingsStore
    .getState()
    .imageHostTargets.find((t) => t.id === binding.picoraTargetId);
  if (!target) return null;
  return { kbPath: kb.path, relativePath, picoraKbId: binding.picoraKbId, target };
}

/**
 * Fetch the server-side revisions for a document, or null when the cloud
 * phase doesn't apply (unbound KB, sync disabled, no plan, server switch off,
 * doc not on the server yet, or any network failure). Best-effort by design —
 * callers treat null as "local-only mode", never as an error.
 */
export async function fetchRemoteRevisions(
  filePath: string
): Promise<RemoteRevisionsContext | null> {
  try {
    if (settingsStore.getState().kbSyncEnabled === false) return null;
    const ctx = resolveBindingContext(filePath);
    if (!ctx) return null;

    if (!isKbSyncEntitled(await getPicoraPlan(ctx.target))) return null;

    const apiBase = picoraApiBase(ctx.target.picoraApiUrl);
    const { getPicoraApiKey } = await import('$lib/services/picora/credentials');
    const apiKey = await getPicoraApiKey(ctx.target);
    if (!apiKey) return null;

    // Server-side user switch + fresh docId lookup, in parallel
    const [userInfo, manifest] = await Promise.all([
      invoke<{ docVersioningEnabled?: boolean }>('verify_picora_token', { apiBase, apiKey }),
      fetchManifest(apiBase, apiKey, ctx.picoraKbId),
    ]);
    if (userInfo.docVersioningEnabled !== true) return null;

    const entry = manifest.find((e) => e.relativePath === ctx.relativePath);
    const docId = entry?.docId;
    if (!docId) return null;

    const list = await invoke<RemoteRevisionList>('picora_doc_revisions', {
      apiBase,
      apiKey,
      docId,
    });
    return { apiBase, apiKey, docId, revisions: list.revisions, totalBytes: list.totalBytes };
  } catch {
    return null;
  }
}

/**
 * Merge local snapshots with server revisions into one panel list.
 *
 * - A local entry whose sourceHash matches a server revision gets
 *   `remote = {revId, syncedAt}` (the "P" badge). Each server revision is
 *   consumed at most once (repeated content A→B→A pairs up positionally,
 *   newest first).
 * - Server revisions with no local match become cloud-only rows.
 * - Sorted by createdAt descending (ISO strings compare lexicographically).
 *
 * The rolling "P" semantics need no client logic: the server list is already
 * pruned to the account's docVersioningMax, so older local versions simply
 * stop matching.
 */
export function mergeRemoteRevisions(
  local: VersionEntry[],
  remote: RemoteRevision[]
): MergedVersionRow[] {
  const consumed = new Set<string>();
  const rows: MergedVersionRow[] = local.map((entry) => {
    const match = remote.find((r) => !consumed.has(r.id) && r.sourceHash === entry.sourceHash);
    if (!match) return { ...entry };
    consumed.add(match.id);
    return { ...entry, remote: { revId: match.id, syncedAt: match.createdAt } };
  });

  for (const r of remote) {
    if (consumed.has(r.id)) continue;
    rows.push({
      revNumber: r.revNumber,
      file: '',
      sourceHash: r.sourceHash,
      sizeBytes: r.sizeBytes,
      origin: r.origin,
      createdAt: r.createdAt,
      remote: { revId: r.id, syncedAt: r.createdAt },
      cloudOnly: true,
    });
  }

  return rows.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

/**
 * Fetch a cloud revision's markdown content WITHOUT writing anything to disk.
 * Used for read-only version preview. Returns null on failure.
 */
export async function fetchRemoteRevisionContent(
  ctx: Pick<RemoteRevisionsContext, 'apiBase' | 'apiKey' | 'docId'>,
  revId: string
): Promise<string | null> {
  try {
    const rev = await invoke<{ content: string }>('picora_doc_revision_content', {
      apiBase: ctx.apiBase,
      apiKey: ctx.apiKey,
      docId: ctx.docId,
      revId,
    });
    return rev.content;
  } catch {
    return null;
  }
}

/**
 * Restore a cloud-only revision: pull its content from the server, then run
 * the local restore flow (current content snapshotted first). Returns the
 * restored content, or null on failure.
 */
export async function restoreRemoteVersion(
  filePath: string,
  ctx: Pick<RemoteRevisionsContext, 'apiBase' | 'apiKey' | 'docId'>,
  revId: string
): Promise<string | null> {
  const content = await fetchRemoteRevisionContent(ctx, revId);
  if (content == null) return null;
  return await restoreContent(filePath, content);
}
