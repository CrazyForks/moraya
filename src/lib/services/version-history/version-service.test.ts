import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (hoisted before imports) ─────────────────────────────

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('$lib/stores/files-store', () => ({
  filesStore: {
    findKnowledgeBaseForFile: vi.fn(),
  },
}));

vi.mock('$lib/stores/settings-store', () => ({
  settingsStore: {
    getState: vi.fn(),
  },
}));

import { invoke } from '@tauri-apps/api/core';
import { filesStore } from '$lib/stores/files-store';
import { settingsStore } from '$lib/stores/settings-store';
import {
  snapshotVersion,
  listVersions,
  restoreVersion,
  clearVersions,
  renameVersionsDir,
  isVersionedPath,
  relativePathFor,
  versionsDirFor,
  snapshotFileName,
  pruneEntries,
  rebuildMetaFromFiles,
  sha256Hex,
  type VersionMeta,
  type VersionEntry,
} from './version-service';

const KB = { id: 'kb1', name: 'KB', path: '/home/u/kb', lastAccessedAt: 0 };
const DOC = '/home/u/kb/notes/a.md';
const VDIR = '/home/u/kb/.versions/notes/a.md';

function mockSettings(overrides?: Partial<{ versionHistoryEnabled: boolean; versionHistoryMax: number }>) {
  vi.mocked(settingsStore.getState).mockReturnValue({
    versionHistoryEnabled: true,
    versionHistoryMax: 50,
    ...overrides,
  } as ReturnType<typeof settingsStore.getState>);
}

/** Route invoke('read_file'|'write_file'|'delete_file'|'read_dir_recursive') to an in-memory FS. */
function mockFs(files: Record<string, string>) {
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    const a = args as { path: string; content?: string };
    if (cmd === 'read_file') {
      if (a.path in files) return files[a.path];
      throw new Error('File not found');
    }
    if (cmd === 'write_file') {
      files[a.path] = a.content ?? '';
      return undefined;
    }
    if (cmd === 'delete_file') {
      for (const k of Object.keys(files)) {
        if (k === a.path || k.startsWith(a.path + '/')) delete files[k];
      }
      return undefined;
    }
    if (cmd === 'read_dir_recursive') {
      const names = Object.keys(files)
        .filter((k) => k.startsWith(a.path + '/'))
        .map((k) => k.slice(a.path.length + 1))
        .filter((rel) => !rel.includes('/'));
      if (names.length === 0) throw new Error('Directory not found');
      return names.map((name) => ({ name, path: `${a.path}/${name}`, is_dir: false }));
    }
    throw new Error(`unmocked command: ${cmd}`);
  });
  return files;
}

function readMeta(files: Record<string, string>): VersionMeta {
  return JSON.parse(files[`${VDIR}/meta.json`]) as VersionMeta;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSettings();
  vi.mocked(filesStore.findKnowledgeBaseForFile).mockReturnValue(KB);
});

// ── Pure helpers ──────────────────────────────────────────────────────

describe('relativePathFor', () => {
  it('should return the path relative to the KB root', () => {
    expect(relativePathFor('/home/u/kb', DOC)).toBe('notes/a.md');
  });

  it('should tolerate a trailing slash on the KB root', () => {
    expect(relativePathFor('/home/u/kb/', DOC)).toBe('notes/a.md');
  });

  it('should return null for a file outside the KB', () => {
    expect(relativePathFor('/home/u/kb', '/home/u/other/a.md')).toBeNull();
  });

  it('should normalize backslashes', () => {
    expect(relativePathFor('C:\\u\\kb', 'C:\\u\\kb\\a.md')).toBe('a.md');
  });
});

describe('versionsDirFor', () => {
  it('should build the .versions dir path under the KB root', () => {
    expect(versionsDirFor('/home/u/kb', 'notes/a.md')).toBe(VDIR);
  });
});

describe('snapshotFileName', () => {
  it('should format as timestamp plus rev suffix', () => {
    const name = snapshotFileName(7, new Date('2026-07-10T14:30:45Z'));
    expect(name).toBe('2026-07-10_14-30-45_r7.md');
  });
});

describe('pruneEntries', () => {
  const entry = (rev: number): VersionEntry => ({
    revNumber: rev,
    file: `f${rev}.md`,
    sourceHash: `h${rev}`,
    sizeBytes: 1,
    origin: 'auto',
    createdAt: '',
  });

  it('should keep all entries when under the cap', () => {
    const meta: VersionMeta = { nextRevNumber: 3, entries: [entry(2), entry(1)] };
    const { meta: kept, removed } = pruneEntries(meta, 5);
    expect(kept.entries).toHaveLength(2);
    expect(removed).toHaveLength(0);
  });

  it('should drop the oldest entries beyond the cap', () => {
    const meta: VersionMeta = { nextRevNumber: 5, entries: [entry(4), entry(3), entry(2), entry(1)] };
    const { meta: kept, removed } = pruneEntries(meta, 2);
    expect(kept.entries.map((e) => e.revNumber)).toEqual([4, 3]);
    expect(removed.map((e) => e.revNumber)).toEqual([2, 1]);
  });

  it('should clamp the cap to at least 1', () => {
    const meta: VersionMeta = { nextRevNumber: 3, entries: [entry(2), entry(1)] };
    const { meta: kept } = pruneEntries(meta, 0);
    expect(kept.entries).toHaveLength(1);
  });
});

describe('rebuildMetaFromFiles', () => {
  it('should rebuild entries newest-first with sequential rev numbers', () => {
    const meta = rebuildMetaFromFiles([
      '2026-07-10_10-00-00_r1.md',
      '2026-07-10_12-00-00_r2.md',
      'meta.json.bak',
    ]);
    expect(meta.entries).toHaveLength(2);
    expect(meta.entries[0].file).toBe('2026-07-10_12-00-00_r2.md');
    expect(meta.entries[0].revNumber).toBe(2);
    expect(meta.entries[1].revNumber).toBe(1);
    expect(meta.nextRevNumber).toBe(3);
  });

  it('should parse the timestamp from the filename', () => {
    const meta = rebuildMetaFromFiles(['2026-07-10_14-30-45_r1.md']);
    expect(meta.entries[0].createdAt).toBe('2026-07-10T14:30:45');
  });
});

describe('sha256Hex', () => {
  it('should produce the canonical SHA-256 hex digest', async () => {
    // Known digest of "abc"
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });
});

// ── snapshotVersion ───────────────────────────────────────────────────

describe('snapshotVersion', () => {
  it('should write a snapshot file and meta.json for a KB document', async () => {
    const files = mockFs({});
    await snapshotVersion(DOC, '# hello', 'manual');
    const meta = readMeta(files);
    expect(meta.entries).toHaveLength(1);
    expect(meta.entries[0].revNumber).toBe(1);
    expect(meta.entries[0].origin).toBe('manual');
    expect(meta.entries[0].sizeBytes).toBe(7);
    expect(files[`${VDIR}/${meta.entries[0].file}`]).toBe('# hello');
  });

  it('should skip when content hash matches the latest snapshot (dedupe)', async () => {
    const files = mockFs({});
    await snapshotVersion(DOC, '# hello', 'manual');
    await snapshotVersion(DOC, '# hello', 'auto');
    expect(readMeta(files).entries).toHaveLength(1);
  });

  it('should create a new version when content changes', async () => {
    const files = mockFs({});
    await snapshotVersion(DOC, 'v1', 'manual');
    await snapshotVersion(DOC, 'v2', 'auto');
    const meta = readMeta(files);
    expect(meta.entries).toHaveLength(2);
    expect(meta.entries[0].revNumber).toBe(2);
    expect(meta.entries[0].origin).toBe('auto');
  });

  it('should prune the oldest snapshots beyond versionHistoryMax', async () => {
    mockSettings({ versionHistoryMax: 2 });
    const files = mockFs({});
    await snapshotVersion(DOC, 'v1', 'manual');
    await snapshotVersion(DOC, 'v2', 'manual');
    await snapshotVersion(DOC, 'v3', 'manual');
    const meta = readMeta(files);
    expect(meta.entries.map((e) => e.revNumber)).toEqual([3, 2]);
    // pruned snapshot file physically deleted
    const snapshotFiles = Object.keys(files).filter((k) => k !== `${VDIR}/meta.json`);
    expect(snapshotFiles).toHaveLength(2);
  });

  it('should no-op when the feature is disabled', async () => {
    mockSettings({ versionHistoryEnabled: false });
    const files = mockFs({});
    await snapshotVersion(DOC, '# hello', 'manual');
    expect(Object.keys(files)).toHaveLength(0);
  });

  it('should no-op for a document outside every KB', async () => {
    vi.mocked(filesStore.findKnowledgeBaseForFile).mockReturnValue(undefined);
    const files = mockFs({});
    await snapshotVersion('/home/u/other/a.md', '# hello', 'manual');
    expect(Object.keys(files)).toHaveLength(0);
  });

  it('should never throw when the write fails (best-effort)', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('disk full'));
    await expect(snapshotVersion(DOC, '# hello', 'manual')).resolves.toBeUndefined();
  });
});

// ── listVersions ──────────────────────────────────────────────────────

describe('listVersions', () => {
  it('should return entries newest first', async () => {
    mockFs({});
    await snapshotVersion(DOC, 'v1', 'manual');
    await snapshotVersion(DOC, 'v2', 'manual');
    const list = await listVersions(DOC);
    expect(list.map((e) => e.revNumber)).toEqual([2, 1]);
  });

  it('should return an empty list for a non-KB document', async () => {
    vi.mocked(filesStore.findKnowledgeBaseForFile).mockReturnValue(undefined);
    expect(await listVersions('/home/u/other/a.md')).toEqual([]);
  });

  it('should rebuild from the snapshot files when meta.json is corrupt', async () => {
    const files = mockFs({
      [`${VDIR}/meta.json`]: 'not json{{{',
      [`${VDIR}/2026-07-10_10-00-00_r1.md`]: 'old',
      [`${VDIR}/2026-07-10_12-00-00_r2.md`]: 'new',
    });
    const list = await listVersions(DOC);
    expect(list).toHaveLength(2);
    expect(list[0].file).toBe('2026-07-10_12-00-00_r2.md');
    expect(files).toBeDefined();
  });
});

// ── restoreVersion ────────────────────────────────────────────────────

describe('restoreVersion', () => {
  it('should snapshot the current content as origin=restore, then write the old content back', async () => {
    const files = mockFs({ [DOC]: 'current content' });
    await snapshotVersion(DOC, 'old content', 'manual');
    const entry = (await listVersions(DOC))[0];
    // simulate further edits saved to disk after that snapshot
    files[DOC] = 'current content';

    const restored = await restoreVersion(DOC, entry);
    expect(restored).toBe('old content');
    expect(files[DOC]).toBe('old content');

    const list = await listVersions(DOC);
    // newest entry is the pre-restore safety snapshot of the current content
    expect(list[0].origin).toBe('restore');
    const dir = VDIR;
    expect(files[`${dir}/${list[0].file}`]).toBe('current content');
  });

  it('should snapshot the current content even when the feature toggle is off', async () => {
    const files = mockFs({ [DOC]: 'current content' });
    await snapshotVersion(DOC, 'old content', 'manual'); // while enabled
    const entry = (await listVersions(DOC))[0];
    mockSettings({ versionHistoryEnabled: false });

    await restoreVersion(DOC, entry);
    const list = await listVersions(DOC);
    expect(list[0].origin).toBe('restore');
    expect(files[DOC]).toBe('old content');
  });

  it('should return null when the snapshot file is unreadable', async () => {
    mockFs({ [DOC]: 'current' });
    const bogus: VersionEntry = {
      revNumber: 9,
      file: 'missing.md',
      sourceHash: '',
      sizeBytes: 0,
      origin: 'manual',
      createdAt: '',
    };
    expect(await restoreVersion(DOC, bogus)).toBeNull();
  });
});

// ── clearVersions / renameVersionsDir / isVersionedPath ──────────────

describe('clearVersions', () => {
  it('should delete the whole versions directory', async () => {
    const files = mockFs({});
    await snapshotVersion(DOC, 'v1', 'manual');
    expect(await clearVersions(DOC)).toBe(true);
    expect(Object.keys(files).filter((k) => k.startsWith(VDIR))).toHaveLength(0);
  });
});

describe('renameVersionsDir', () => {
  it('should rename the versions dir when both paths are inside the KB', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await renameVersionsDir(DOC, '/home/u/kb/notes/b.md');
    expect(invoke).toHaveBeenCalledWith('rename_file', {
      oldPath: VDIR,
      newPath: '/home/u/kb/.versions/notes/b.md',
    });
  });

  it('should no-op when the file is outside every KB', async () => {
    vi.mocked(filesStore.findKnowledgeBaseForFile).mockReturnValue(undefined);
    await renameVersionsDir('/x/a.md', '/x/b.md');
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('isVersionedPath', () => {
  it('should be true for a KB document', () => {
    expect(isVersionedPath(DOC)).toBe(true);
  });

  it('should be false for null or a non-KB path', () => {
    expect(isVersionedPath(null)).toBe(false);
    vi.mocked(filesStore.findKnowledgeBaseForFile).mockReturnValue(undefined);
    expect(isVersionedPath('/home/u/other/a.md')).toBe(false);
  });
});
