import { describe, it, expect, vi } from 'vitest';

// cloud-revisions imports stores/ipc transitively — stub them so the pure
// mergeRemoteRevisions tests don't drag the Tauri runtime in.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('$lib/stores/files-store', () => ({ filesStore: { findKnowledgeBaseForFile: vi.fn() } }));
vi.mock('$lib/stores/settings-store', () => ({ settingsStore: { getState: vi.fn() } }));
vi.mock('$lib/services/picora/entitlement', () => ({
  getPicoraPlan: vi.fn(),
  isKbSyncEntitled: vi.fn(),
}));

import { mergeRemoteRevisions, type RemoteRevision } from './cloud-revisions';
import type { VersionEntry } from './version-service';

function localEntry(rev: number, hash: string, createdAt: string): VersionEntry {
  return {
    revNumber: rev,
    file: `2026-07-10_10-00-0${rev}_r${rev}.md`,
    sourceHash: hash,
    sizeBytes: 100,
    origin: 'manual',
    createdAt,
  };
}

function remoteRev(id: string, rev: number, hash: string, createdAt: string): RemoteRevision {
  return {
    id: id.padEnd(21, '0'),
    revNumber: rev,
    sizeBytes: 200,
    origin: 'sync',
    sourceHash: hash,
    createdAt,
  };
}

describe('mergeRemoteRevisions', () => {
  it('should badge a local entry whose hash matches a server revision', () => {
    const local = [localEntry(1, 'aaa', '2026-07-10T10:00:00Z')];
    const remote = [remoteRev('r1', 1, 'aaa', '2026-07-10T10:00:05Z')];
    const rows = mergeRemoteRevisions(local, remote);
    expect(rows).toHaveLength(1);
    expect(rows[0].remote).toEqual({ revId: 'r1'.padEnd(21, '0'), syncedAt: '2026-07-10T10:00:05Z' });
    expect(rows[0].cloudOnly).toBeUndefined();
  });

  it('should leave a local entry unbadged when no server hash matches', () => {
    const local = [localEntry(1, 'aaa', '2026-07-10T10:00:00Z')];
    const remote = [remoteRev('r1', 1, 'bbb', '2026-07-10T10:00:05Z')];
    const rows = mergeRemoteRevisions(local, remote);
    const localRow = rows.find((r) => !r.cloudOnly)!;
    expect(localRow.remote).toBeUndefined();
  });

  it('should surface unmatched server revisions as cloud-only rows', () => {
    const local = [localEntry(1, 'aaa', '2026-07-10T10:00:00Z')];
    const remote = [
      remoteRev('r1', 1, 'aaa', '2026-07-10T10:00:05Z'),
      remoteRev('r2', 2, 'ccc', '2026-07-10T11:00:00Z'),
    ];
    const rows = mergeRemoteRevisions(local, remote);
    expect(rows).toHaveLength(2);
    const cloud = rows.find((r) => r.cloudOnly)!;
    expect(cloud.sourceHash).toBe('ccc');
    expect(cloud.origin).toBe('sync');
    expect(cloud.file).toBe('');
    expect(cloud.remote?.revId).toBe('r2'.padEnd(21, '0'));
  });

  it('should consume each server revision at most once (A→B→A pairing)', () => {
    const local = [
      localEntry(3, 'aaa', '2026-07-10T12:00:00Z'),
      localEntry(2, 'bbb', '2026-07-10T11:00:00Z'),
      localEntry(1, 'aaa', '2026-07-10T10:00:00Z'),
    ];
    // Only ONE server revision with hash aaa — must badge one local row, not both
    const remote = [remoteRev('r1', 1, 'aaa', '2026-07-10T12:00:05Z')];
    const rows = mergeRemoteRevisions(local, remote);
    const badged = rows.filter((r) => r.remote);
    expect(badged).toHaveLength(1);
    expect(rows.filter((r) => r.cloudOnly)).toHaveLength(0);
  });

  it('should sort merged rows by createdAt descending', () => {
    const local = [localEntry(1, 'aaa', '2026-07-10T10:00:00Z')];
    const remote = [remoteRev('r9', 9, 'zzz', '2026-07-10T12:00:00Z')];
    const rows = mergeRemoteRevisions(local, remote);
    expect(rows[0].cloudOnly).toBe(true); // newer cloud row first
    expect(rows[1].sourceHash).toBe('aaa');
  });

  it('should return local rows unchanged when the server list is empty', () => {
    const local = [localEntry(2, 'bbb', '2026-07-10T11:00:00Z'), localEntry(1, 'aaa', '2026-07-10T10:00:00Z')];
    const rows = mergeRemoteRevisions(local, []);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => !r.remote && !r.cloudOnly)).toBe(true);
  });

  it('should return only cloud-only rows when there are no local snapshots', () => {
    const remote = [remoteRev('r1', 1, 'aaa', '2026-07-10T10:00:00Z')];
    const rows = mergeRemoteRevisions([], remote);
    expect(rows).toHaveLength(1);
    expect(rows[0].cloudOnly).toBe(true);
  });
});
