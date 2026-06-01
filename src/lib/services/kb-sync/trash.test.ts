import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import {
  listTrash,
  restoreFromTrash,
  purgeTrash,
  groupByKb,
  filterSince,
  formatBytes,
  type TrashEntry,
} from './trash';

const mockedInvoke = invoke as ReturnType<typeof vi.fn>;

function makeEntry(overrides?: Partial<TrashEntry>): TrashEntry {
  return {
    kbId: 'kb-1',
    deletedAt: '2026-05-27T18-42-03Z',
    deletedAtMs: 1779907323000,
    relativePath: 'notes/a.md',
    sizeBytes: 1024,
    absoluteTrashPath: '/home/u/.moraya/trash/kb-1/2026-05-27T18-42-03Z/notes/a.md',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listTrash', () => {
  it('invokes kb_sync_list_trash with null defaults', async () => {
    mockedInvoke.mockResolvedValueOnce([]);
    await listTrash();
    expect(mockedInvoke).toHaveBeenCalledWith('kb_sync_list_trash', {
      kbId: null,
      limit: null,
    });
  });

  it('passes through kbId and limit', async () => {
    mockedInvoke.mockResolvedValueOnce([]);
    await listTrash('kb-2', 50);
    expect(mockedInvoke).toHaveBeenCalledWith('kb_sync_list_trash', {
      kbId: 'kb-2',
      limit: 50,
    });
  });

  it('returns the rust-side TrashEntry[] verbatim', async () => {
    const entry = makeEntry();
    mockedInvoke.mockResolvedValueOnce([entry]);
    const out = await listTrash();
    expect(out).toEqual([entry]);
  });
});

describe('restoreFromTrash', () => {
  it('defaults overwrite to false', async () => {
    mockedInvoke.mockResolvedValueOnce({ kind: 'restored', targetPath: '/x' });
    await restoreFromTrash({
      kbId: 'k',
      deletedAt: 'ts',
      relativePath: 'a.md',
      kbRoot: '/r',
    });
    expect(mockedInvoke).toHaveBeenCalledWith('kb_sync_restore_from_trash', {
      kbId: 'k',
      deletedAt: 'ts',
      relativePath: 'a.md',
      kbRoot: '/r',
      overwrite: false,
    });
  });

  it('passes overwrite=true when explicitly set', async () => {
    mockedInvoke.mockResolvedValueOnce({ kind: 'restored', targetPath: '/x' });
    await restoreFromTrash({
      kbId: 'k',
      deletedAt: 'ts',
      relativePath: 'a.md',
      kbRoot: '/r',
      overwrite: true,
    });
    expect((mockedInvoke.mock.calls[0]![1] as { overwrite: boolean }).overwrite).toBe(true);
  });

  it('surfaces conflict-exists result', async () => {
    mockedInvoke.mockResolvedValueOnce({ kind: 'conflict-exists', existingSize: 99 });
    const out = await restoreFromTrash({
      kbId: 'k', deletedAt: 'ts', relativePath: 'a.md', kbRoot: '/r',
    });
    expect(out.kind).toBe('conflict-exists');
    if (out.kind === 'conflict-exists') expect(out.existingSize).toBe(99);
  });
});

describe('purgeTrash', () => {
  it('sends nulls when no options given', async () => {
    mockedInvoke.mockResolvedValueOnce({ purgedFiles: 0, purgedDirs: 0, freedBytes: 0 });
    await purgeTrash();
    expect(mockedInvoke).toHaveBeenCalledWith('kb_sync_purge_trash', {
      kbId: null,
      olderThanDays: null,
    });
  });

  it('forwards kbId + olderThanDays', async () => {
    mockedInvoke.mockResolvedValueOnce({ purgedFiles: 3, purgedDirs: 1, freedBytes: 10 });
    const r = await purgeTrash({ kbId: 'kb-x', olderThanDays: 14 });
    expect(mockedInvoke).toHaveBeenCalledWith('kb_sync_purge_trash', {
      kbId: 'kb-x',
      olderThanDays: 14,
    });
    expect(r.purgedFiles).toBe(3);
  });
});

describe('groupByKb', () => {
  it('groups multiple kbs', () => {
    const a = makeEntry({ kbId: 'A', relativePath: '1' });
    const b1 = makeEntry({ kbId: 'B', relativePath: '2' });
    const b2 = makeEntry({ kbId: 'B', relativePath: '3' });
    const m = groupByKb([a, b1, b2]);
    expect(m.size).toBe(2);
    expect(m.get('A')?.length).toBe(1);
    expect(m.get('B')?.length).toBe(2);
  });

  it('preserves input order within a group', () => {
    const items = [
      makeEntry({ relativePath: 'first' }),
      makeEntry({ relativePath: 'second' }),
      makeEntry({ relativePath: 'third' }),
    ];
    const m = groupByKb(items);
    expect(m.get('kb-1')?.map(e => e.relativePath)).toEqual(['first', 'second', 'third']);
  });
});

describe('filterSince', () => {
  it('drops entries older than cutoff', () => {
    const items = [
      makeEntry({ deletedAtMs: 1000, relativePath: 'old' }),
      makeEntry({ deletedAtMs: 2000, relativePath: 'mid' }),
      makeEntry({ deletedAtMs: 3000, relativePath: 'new' }),
    ];
    const out = filterSince(items, 2000);
    expect(out.map(e => e.relativePath)).toEqual(['mid', 'new']);
  });

  it('keeps entry exactly at cutoff', () => {
    const items = [makeEntry({ deletedAtMs: 2000 })];
    expect(filterSince(items, 2000)).toHaveLength(1);
  });
});

describe('formatBytes', () => {
  it('< 1 KB uses bytes', () => expect(formatBytes(512)).toBe('512 B'));
  it('1 KB ≤ x < 1 MB uses KB', () => expect(formatBytes(2048)).toBe('2.0 KB'));
  it('1 MB ≤ x < 1 GB uses MB', () => expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB'));
  it('≥ 1 GB uses GB', () => expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GB'));
});
