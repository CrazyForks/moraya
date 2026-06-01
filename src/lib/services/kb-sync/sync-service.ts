import { invoke } from '@tauri-apps/api/core';
import { writable, get } from 'svelte/store';
import { threeWayDiff } from './diff';
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
    const [localManifest, lastManifest, remoteEntries] = await Promise.all([
      buildLocalManifest(kb.path, strategy.scope, strategy.excludePatterns),
      loadLastManifest(localKbId),
      fetchManifest(apiBase, apiKey, picoraKbId),
    ]);

    const remoteManifest: RemoteManifest = new Map(
      remoteEntries.map(e => [e.relativePath, e])
    );

    const diff = threeWayDiff(
      lastManifest,
      localManifest,
      remoteManifest,
      strategy.maxFileSizeBytes,
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

    // Build upload ops
    const uploadOps = await Promise.all(
      diff.uploadPaths.map(async (relativePath) => {
        const content = await invoke<string>('read_file', {
          path: `${kb.path}/${relativePath}`,
        });
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
      report.uploaded = batchResult.applied.filter(p =>
        diff.uploadPaths.includes(p)
      ).length;
      report.deletedRemote = batchResult.applied.filter(p =>
        diff.deleteRemotePaths.includes(p)
      ).length;
      batchConflicts = batchResult.conflicts;
    }

    // Download from remote
    for (const relativePath of diff.downloadPaths) {
      const content = await fetchRaw(apiBase, apiKey, picoraKbId, relativePath);
      await invoke('write_file', {
        path: `${kb.path}/${relativePath}`,
        content,
      });
      report.downloaded++;
    }

    // Delete local (move to trash)
    for (const relativePath of diff.deleteLocalPaths) {
      await moveToTrash(kb.path, localKbId, relativePath);
      report.deletedLocal++;
    }

    // Build conflicts (locally detected + server-detected)
    const localConflicts: ConflictEntry[] = diff.conflictPaths.map(relativePath => {
      const local = localManifest.get(relativePath);
      const remote = remoteManifest.get(relativePath);
      return {
        relativePath,
        localUpdatedAt: local ? new Date(local.mtime).toISOString() : '',
        remoteUpdatedAt: remote?.updatedAt ?? '',
        localSizeBytes: local?.sizeBytes ?? 0,
        remoteSizeBytes: remote?.sizeBytes ?? 0,
        localPreview: '',
        remotePreview: '',
        localHash: local?.sourceHash ?? '',
        remoteHash: remote?.sourceHash ?? '',
      };
    });

    const allConflicts = [...localConflicts, ...batchConflicts];
    report.conflicts = allConflicts.length;

    // Update last manifest (only for successfully applied entries)
    const newLastManifest: RemoteManifest = new Map(lastManifest);
    for (const relativePath of diff.downloadPaths) {
      const entry = remoteManifest.get(relativePath);
      if (entry) newLastManifest.set(relativePath, entry);
    }
    for (const relativePath of diff.uploadPaths) {
      const local = localManifest.get(relativePath);
      if (local) {
        const entry: ManifestEntry = {
          relativePath,
          sourceHash: local.sourceHash,
          sizeBytes: local.sizeBytes,
          updatedAt: new Date().toISOString(),
        };
        newLastManifest.set(relativePath, entry);
      }
    }
    for (const relativePath of [...diff.deleteRemotePaths, ...diff.deleteLocalPaths]) {
      newLastManifest.delete(relativePath);
    }

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
