import { invoke } from '@tauri-apps/api/core';
import { writable, get } from 'svelte/store';
import { threeWayDiff } from './diff';
import { threeWayMergeLines } from './merge';
import { saveBaseContent, loadBaseContent, deleteBaseContent } from './base-cache';
import { buildLocalManifest, loadLastManifest, saveLastManifest, moveToTrash } from './manifest';
import {
  listKbs,
  createKb,
  fetchManifest,
  syncBatch,
  fetchRaw,
  picoraApiBase,
} from './picora-kb-client';
import type {
  KbBinding,
  SyncReport,
  ConflictEntry,
  RemoteManifest,
  ManifestEntry,
  KbSyncState,
  DiffResult,
} from './types';
import type { ImageHostTarget } from '$lib/services/image-hosting/types';
import type { KnowledgeBase } from '$lib/stores/files-store';

export { listKbs, createKb, picoraApiBase };

/** SHA-256 hex of a UTF-8 string — matches the Rust local hash
 *  (`format!("{:x}", Sha256::digest(bytes))`) for UTF-8 files. */
async function sha256Hex(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Dot-prefixed top-level namespaces other than `.moraya` are AI-memory tool
 * directories (`.claude/`, `.cursor/`, `.codex/`…). They are managed by the
 * separate memory binding-sync engine (push from `~/.claude` → cloud namespace)
 * and pulled only via explicit "restore" — never folder-synced into the KB's
 * local path. So KB folder sync ignores them: an unbound tool's hidden data is
 * neither downloaded into the folder nor uploaded from it. `.moraya` is the KB's
 * own rules/memory and stays part of folder sync.
 */
export function isMemoryNamespacePath(relativePath: string): boolean {
  const slash = relativePath.indexOf('/');
  const top = slash === -1 ? relativePath : relativePath.slice(0, slash);
  return top.startsWith('.') && top !== '.moraya';
}

function stripMemoryNamespaces<V>(m: Map<string, V>): Map<string, V> {
  const out = new Map<string, V>();
  for (const [k, v] of m) if (!isMemoryNamespacePath(k)) out.set(k, v);
  return out;
}

// ── Sync state store ─────────────────────────────────────────────────

function createKbSyncStore() {
  const { subscribe, update } = writable<Map<string, KbSyncState>>(new Map());

  return {
    subscribe,
    setState(localKbId: string, partial: Partial<KbSyncState>) {
      update(map => {
        const existing = map.get(localKbId) ?? {
          localKbId,
          status: 'unbound',
          conflictCount: 0,
          pendingConflicts: [],
          lastError: null,
        };
        const next = new Map(map);
        next.set(localKbId, { ...existing, ...partial });
        return next;
      });
    },
    getState(localKbId: string): KbSyncState {
      const map = get({ subscribe });
      return map.get(localKbId) ?? {
        localKbId,
        status: 'unbound',
        conflictCount: 0,
        pendingConflicts: [],
        lastError: null,
      };
    },
  };
}

export const kbSyncStore = createKbSyncStore();

// ── Interval scheduler ───────────────────────────────────────────────

const intervalMap = new Map<string, ReturnType<typeof setInterval>>();

export function registerKbInterval(
  binding: KbBinding,
  kb: KnowledgeBase,
  target: ImageHostTarget,
  onComplete?: (report: SyncReport) => void,
) {
  clearKbInterval(binding.localKbId);
  if (binding.strategy.mode !== 'interval') return;

  const id = setInterval(async () => {
    await runSync(binding, kb, target, false, onComplete);
  }, binding.strategy.intervalSecs * 1000);

  intervalMap.set(binding.localKbId, id);
}

export function clearKbInterval(localKbId: string) {
  const id = intervalMap.get(localKbId);
  if (id !== undefined) {
    clearInterval(id);
    intervalMap.delete(localKbId);
  }
}

export function clearAllIntervals() {
  for (const [id] of intervalMap) clearKbInterval(id);
}

// ── Core sync runner ─────────────────────────────────────────────────

export async function runSync(
  binding: KbBinding,
  kb: KnowledgeBase,
  target: ImageHostTarget,
  dryRun: boolean,
  onComplete?: (report: SyncReport) => void,
): Promise<Omit<SyncReport, 'conflicts'> & { conflicts: ConflictEntry[]; diff?: DiffResult }> {
  const { localKbId, picoraKbId, strategy } = binding;
  const apiBase = picoraApiBase(target.picoraApiUrl);
  const { getPicoraApiKey } = await import('$lib/services/picora/credentials');
  const apiKey = await getPicoraApiKey(target);

  kbSyncStore.setState(localKbId, { status: 'syncing', lastError: null });

  try {
    const [localManifestRaw, lastManifestRaw, remoteEntries] = await Promise.all([
      buildLocalManifest(kb.path, strategy.scope, strategy.excludePatterns),
      loadLastManifest(localKbId),
      fetchManifest(apiBase, apiKey, picoraKbId),
    ]);

    // Exclude AI-memory tool namespaces (`.claude/`…) from folder sync in BOTH
    // directions — they're handled by the memory binding engine, not folder sync.
    const localManifest = stripMemoryNamespaces(localManifestRaw);
    const lastManifest = stripMemoryNamespaces(lastManifestRaw);
    const remoteManifest: RemoteManifest = stripMemoryNamespaces(
      new Map(remoteEntries.map(e => [e.relativePath, e]))
    );

    // First sync (no base): this machine is the initial authority — divergent
    // both-exist files upload rather than conflict. See InitialAuthority.
    const diff = threeWayDiff(
      lastManifest,
      localManifest,
      remoteManifest,
      strategy.maxFileSizeBytes,
      'local',
    );

    if (dryRun) {
      kbSyncStore.setState(localKbId, { status: 'idle' });
      return {
        uploaded: diff.uploadPaths.length,
        downloaded: diff.downloadPaths.length,
        deletedRemote: diff.deleteRemotePaths.length,
        deletedLocal: diff.deleteLocalPaths.length,
        skipped: diff.skippedLarge.length,
        conflicts: diff.conflictPaths.length,
        diff,
      } as unknown as Omit<SyncReport, 'conflicts'> & { conflicts: ConflictEntry[]; diff: DiffResult };
    }

    // ── Execute non-conflict operations ──
    const report: SyncReport = {
      uploaded: 0,
      downloaded: 0,
      deletedRemote: 0,
      deletedLocal: 0,
      skipped: diff.skippedLarge.length,
      conflicts: diff.conflictPaths.length,
    };

    // Running manifest of the last-agreed state; updated as each op succeeds.
    const newLastManifest: RemoteManifest = new Map(lastManifest);
    const PREVIEW_LIMIT = 2000;

    // ── Uploads + remote deletes (batch) ──
    const uploadContents = new Map<string, string>();
    const uploadOps = await Promise.all(
      diff.uploadPaths.map(async (relativePath) => {
        const content = await invoke<string>('read_file', {
          path: `${kb.path}/${relativePath}`,
        });
        uploadContents.set(relativePath, content);
        const entry = localManifest.get(relativePath)!;
        const lastEntry = lastManifest.get(relativePath);
        return {
          op: 'upsert' as const,
          relativePath,
          content,
          sourceHash: entry.sourceHash,
          baseUpdatedAt: lastEntry?.updatedAt,
        };
      })
    );

    const deleteRemoteOps = diff.deleteRemotePaths.map(relativePath => ({
      op: 'delete' as const,
      relativePath,
    }));

    const allOps = [...uploadOps, ...deleteRemoteOps];
    let batchConflicts: ConflictEntry[] = [];

    if (allOps.length > 0) {
      const batchResult = await syncBatch(apiBase, apiKey, picoraKbId, allOps);
      const applied = new Set(batchResult.applied);
      batchConflicts = batchResult.conflicts;

      for (const relativePath of diff.uploadPaths) {
        if (!applied.has(relativePath)) continue;
        report.uploaded++;
        const local = localManifest.get(relativePath);
        const content = uploadContents.get(relativePath);
        if (content !== undefined) await saveBaseContent(localKbId, relativePath, content);
        if (local) {
          newLastManifest.set(relativePath, {
            relativePath, sourceHash: local.sourceHash, sizeBytes: local.sizeBytes,
            updatedAt: new Date().toISOString(),
          });
        }
      }
      for (const relativePath of diff.deleteRemotePaths) {
        if (!applied.has(relativePath)) continue;
        report.deletedRemote++;
        newLastManifest.delete(relativePath);
        await deleteBaseContent(localKbId, relativePath);
      }
    }

    // ── Downloads ──
    for (const relativePath of diff.downloadPaths) {
      const content = (await fetchRaw(apiBase, apiKey, picoraKbId, relativePath)) ?? '';
      await invoke('write_file', { path: `${kb.path}/${relativePath}`, content });
      await saveBaseContent(localKbId, relativePath, content);
      const entry = remoteManifest.get(relativePath);
      if (entry) newLastManifest.set(relativePath, entry);
      report.downloaded++;
    }

    // ── Local deletes (move to trash) ──
    for (const relativePath of diff.deleteLocalPaths) {
      await moveToTrash(kb.path, localKbId, relativePath);
      newLastManifest.delete(relativePath);
      await deleteBaseContent(localKbId, relativePath);
      report.deletedLocal++;
    }

    // ── Conflicts: 3-way auto-merge → conflictPolicy → leave pending ──
    const pendingConflicts: ConflictEntry[] = [];
    for (const relativePath of diff.conflictPaths) {
      const localMeta = localManifest.get(relativePath);
      const remoteMeta = remoteManifest.get(relativePath);
      let localContent = '';
      let remoteContent = '';
      try { localContent = (await invoke<string>('read_file', { path: `${kb.path}/${relativePath}` })) ?? ''; } catch { /* best-effort */ }
      try { remoteContent = (await fetchRaw(apiBase, apiKey, picoraKbId, relativePath)) ?? ''; } catch { /* best-effort */ }
      const baseContent = await loadBaseContent(localKbId, relativePath);

      // 1) Clean 3-way auto-merge (non-overlapping edits) → write + upload, no prompt.
      if (baseContent !== null) {
        const merged = threeWayMergeLines(localContent, baseContent, remoteContent);
        if (!merged.hasConflict && merged.mergedText !== null) {
          const text = merged.mergedText;
          const hash = await sha256Hex(text);
          await invoke('write_file', { path: `${kb.path}/${relativePath}`, content: text });
          await syncBatch(apiBase, apiKey, picoraKbId, [
            { op: 'upsert', relativePath, content: text, sourceHash: hash, baseUpdatedAt: remoteMeta?.updatedAt },
          ]);
          await saveBaseContent(localKbId, relativePath, text);
          newLastManifest.set(relativePath, { relativePath, sourceHash: hash, sizeBytes: utf8Len(text), updatedAt: new Date().toISOString() });
          report.uploaded++;
          continue;
        }
      }

      // 2) Auto-resolve per conflictPolicy (skip prompting).
      if (strategy.conflictPolicy === 'prefer-local') {
        const hash = localMeta?.sourceHash ?? await sha256Hex(localContent);
        await syncBatch(apiBase, apiKey, picoraKbId, [
          { op: 'upsert', relativePath, content: localContent, sourceHash: hash, baseUpdatedAt: remoteMeta?.updatedAt },
        ]);
        await saveBaseContent(localKbId, relativePath, localContent);
        newLastManifest.set(relativePath, { relativePath, sourceHash: hash, sizeBytes: localMeta?.sizeBytes ?? utf8Len(localContent), updatedAt: new Date().toISOString() });
        report.uploaded++;
        continue;
      }
      if (strategy.conflictPolicy === 'prefer-remote') {
        await invoke('write_file', { path: `${kb.path}/${relativePath}`, content: remoteContent });
        await saveBaseContent(localKbId, relativePath, remoteContent);
        const entry: ManifestEntry = remoteMeta ?? {
          relativePath, sourceHash: await sha256Hex(remoteContent), sizeBytes: utf8Len(remoteContent), updatedAt: new Date().toISOString(),
        };
        newLastManifest.set(relativePath, entry);
        report.downloaded++;
        continue;
      }

      // 3) prompt → surface with full content + base for the line-level UI.
      pendingConflicts.push({
        relativePath,
        localUpdatedAt: localMeta ? new Date(localMeta.mtime).toISOString() : '',
        remoteUpdatedAt: remoteMeta?.updatedAt ?? '',
        localSizeBytes: localMeta?.sizeBytes ?? 0,
        remoteSizeBytes: remoteMeta?.sizeBytes ?? 0,
        localPreview: localContent.slice(0, PREVIEW_LIMIT),
        remotePreview: remoteContent.slice(0, PREVIEW_LIMIT),
        localHash: localMeta?.sourceHash ?? '',
        remoteHash: remoteMeta?.sourceHash ?? '',
        localContent,
        remoteContent,
        baseContent,
      });
    }

    // Server-detected conflicts arrive without content — enrich for the UI.
    const enrichedBatchConflicts: ConflictEntry[] = [];
    for (const c of batchConflicts) {
      let localContent = '';
      let remoteContent = '';
      try { localContent = (await invoke<string>('read_file', { path: `${kb.path}/${c.relativePath}` })) ?? ''; } catch { /* best-effort */ }
      try { remoteContent = (await fetchRaw(apiBase, apiKey, picoraKbId, c.relativePath)) ?? ''; } catch { /* best-effort */ }
      const baseContent = await loadBaseContent(localKbId, c.relativePath);
      enrichedBatchConflicts.push({
        ...c,
        localContent,
        remoteContent,
        baseContent,
        localPreview: localContent.slice(0, PREVIEW_LIMIT),
        remotePreview: remoteContent.slice(0, PREVIEW_LIMIT),
      });
    }

    const allConflicts = [...pendingConflicts, ...enrichedBatchConflicts];
    report.conflicts = allConflicts.length;

    await saveLastManifest(localKbId, newLastManifest);

    kbSyncStore.setState(localKbId, {
      status: allConflicts.length > 0 ? 'conflict' : 'idle',
      conflictCount: allConflicts.length,
      pendingConflicts: allConflicts,
    });

    onComplete?.(report);
    return { ...report, conflicts: allConflicts };
  } catch (err) {
    const errMsg = typeof err === 'string' ? err : (err instanceof Error ? err.message : 'Sync failed');
    kbSyncStore.setState(localKbId, { status: 'error', lastError: errMsg });
    throw err;
  }
}

/** Perform dry-run for initial binding preview. */
export async function dryRunSync(
  binding: KbBinding,
  kb: KnowledgeBase,
  target: ImageHostTarget,
) {
  return runSync(binding, kb, target, true);
}

/**
 * Apply a user-resolved merged content for a single conflicting file: write it
 * locally, upload to Picora, and record the merged content as the new base +
 * manifest entry so the next sync sees it aligned (no re-conflict). Used by the
 * line-level conflict resolution panel.
 */
export async function applyResolvedContent(
  binding: KbBinding,
  kb: KnowledgeBase,
  target: ImageHostTarget,
  relativePath: string,
  mergedText: string,
): Promise<void> {
  const { localKbId, picoraKbId } = binding;
  const apiBase = picoraApiBase(target.picoraApiUrl);
  const { getPicoraApiKey } = await import('$lib/services/picora/credentials');
  const apiKey = await getPicoraApiKey(target);

  const hash = await sha256Hex(mergedText);
  await invoke('write_file', { path: `${kb.path}/${relativePath}`, content: mergedText });
  await syncBatch(apiBase, apiKey, picoraKbId, [
    { op: 'upsert', relativePath, content: mergedText, sourceHash: hash },
  ]);
  await saveBaseContent(localKbId, relativePath, mergedText);

  const manifest = await loadLastManifest(localKbId);
  manifest.set(relativePath, {
    relativePath, sourceHash: hash, sizeBytes: utf8Len(mergedText), updatedAt: new Date().toISOString(),
  });
  await saveLastManifest(localKbId, manifest);
}
