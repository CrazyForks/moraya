import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import {
  getPicoraApiKey,
  getPicoraApiKeyOrEmpty,
  setPicoraApiKey,
  migratePicoraKeysToKeychain,
  picoraKeychainKey,
  _clearPicoraCredentialCache,
} from './credentials';
import type { ImageHostTarget } from '$lib/services/image-hosting/types';

const mockedInvoke = invoke as ReturnType<typeof vi.fn>;

function makeTarget(overrides?: Partial<ImageHostTarget>): ImageHostTarget {
  return {
    id: 'tg-1',
    name: 'Picora',
    provider: 'picora',
    apiToken: '',
    customEndpoint: '',
    customHeaders: '',
    customUrlTemplate: '',
    autoUpload: false,
    githubRepoUrl: '', githubBranch: '', githubDir: '', githubToken: '', githubCdn: 'jsdelivr',
    gitlabRepoUrl: '', gitlabBranch: '', gitlabDir: '', gitlabToken: '',
    gitCustomRepoUrl: '', gitCustomBranch: '', gitCustomDir: '', gitCustomToken: '',
    ossAccessKey: '', ossSecretKey: '', ossBucket: '', ossRegion: '', ossEndpoint: '',
    ossCdnDomain: '', ossPathPrefix: '',
    picoraApiUrl: 'https://api.picora.me',
    picoraApiKey: '',
    picoraImgDomain: '',
    picoraUserEmail: '',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _clearPicoraCredentialCache();
});

describe('picoraKeychainKey', () => {
  it('uses the documented prefix', () => {
    expect(picoraKeychainKey('foo')).toBe('picora-api-key:foo');
  });
});

describe('getPicoraApiKey', () => {
  it('returns inline picoraApiKey verbatim (legacy path; no keychain call)', async () => {
    const t = makeTarget({ picoraApiKey: 'sk_inline' });
    const result = await getPicoraApiKey(t);
    expect(result).toBe('sk_inline');
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it('falls back to keychain_get when inline key is empty', async () => {
    mockedInvoke.mockResolvedValueOnce('sk_from_keychain');
    const t = makeTarget({ picoraApiKey: '' });
    const result = await getPicoraApiKey(t);
    expect(result).toBe('sk_from_keychain');
    expect(mockedInvoke).toHaveBeenCalledWith('keychain_get', { key: 'picora-api-key:tg-1' });
  });

  it('memoizes keychain reads within a single window', async () => {
    mockedInvoke.mockResolvedValueOnce('sk_cached');
    const t = makeTarget({ picoraApiKey: '' });
    await getPicoraApiKey(t);
    await getPicoraApiKey(t);
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
  });

  it('throws "not configured" when keychain returns null and no inline key', async () => {
    mockedInvoke.mockResolvedValueOnce(null);
    const t = makeTarget({ picoraApiKey: '' });
    await expect(getPicoraApiKey(t)).rejects.toThrow('Picora API key not configured');
  });
});

describe('getPicoraApiKeyOrEmpty', () => {
  it('returns empty string instead of throwing on miss', async () => {
    mockedInvoke.mockResolvedValueOnce(null);
    const t = makeTarget({ picoraApiKey: '' });
    await expect(getPicoraApiKeyOrEmpty(t)).resolves.toBe('');
  });
});

describe('getPicoraApiKey — OAuth branch (v0.69.0 Phase 2)', () => {
  it('routes through picora_oauth_get_token when picoraAuthRef is set', async () => {
    mockedInvoke.mockResolvedValueOnce('at_xyz');
    const t = makeTarget({
      picoraAuthRef: { kind: 'oauth', accountId: 'acct-7' },
      picoraApiUrl: 'https://api.picora.me/v1/images',
    });
    const token = await getPicoraApiKey(t);
    expect(token).toBe('at_xyz');
    expect(mockedInvoke).toHaveBeenCalledWith('picora_oauth_get_token', {
      apiBase: 'https://api.picora.me',
      accountId: 'acct-7',
    });
  });

  it('OAuth branch takes priority over inline picoraApiKey', async () => {
    mockedInvoke.mockResolvedValueOnce('at_from_oauth');
    const t = makeTarget({
      picoraAuthRef: { kind: 'oauth', accountId: 'a' },
      picoraApiKey: 'sk_legacy_should_not_be_used',
    });
    const token = await getPicoraApiKey(t);
    expect(token).toBe('at_from_oauth');
    // Should NOT have called keychain_get for the legacy api-key path
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke).toHaveBeenCalledWith('picora_oauth_get_token', expect.any(Object));
  });

  it('throws "session expired" when OAuth token endpoint returns null', async () => {
    mockedInvoke.mockResolvedValueOnce(null);
    const t = makeTarget({
      picoraAuthRef: { kind: 'oauth', accountId: 'a' },
    });
    await expect(getPicoraApiKey(t)).rejects.toThrow('Picora session expired');
  });

  it('OAuth branch is NOT memoized (Rust side already caches)', async () => {
    mockedInvoke.mockResolvedValue('at_1');
    const t = makeTarget({ picoraAuthRef: { kind: 'oauth', accountId: 'a' } });
    await getPicoraApiKey(t);
    await getPicoraApiKey(t);
    // Both calls hit Rust — we trust the Rust-side cache + auto-refresh.
    // Memoizing on the JS side would serve stale tokens after refresh.
    expect(mockedInvoke).toHaveBeenCalledTimes(2);
  });

  it('passes apiBase=null when picoraApiUrl is empty', async () => {
    mockedInvoke.mockResolvedValueOnce('at');
    const t = makeTarget({
      picoraApiUrl: '',
      picoraAuthRef: { kind: 'oauth', accountId: 'a' },
    });
    await getPicoraApiKey(t);
    expect(mockedInvoke).toHaveBeenCalledWith('picora_oauth_get_token', {
      apiBase: null,
      accountId: 'a',
    });
  });

  it('strips /v1/images suffix when constructing apiBase', async () => {
    mockedInvoke.mockResolvedValueOnce('at');
    const t = makeTarget({
      picoraApiUrl: 'https://staging.picora.me/v1/images',
      picoraAuthRef: { kind: 'oauth', accountId: 'a' },
    });
    await getPicoraApiKey(t);
    const call = mockedInvoke.mock.calls[0]![1] as { apiBase: string };
    expect(call.apiBase).toBe('https://staging.picora.me');
  });

  it('getPicoraApiKeyOrEmpty returns "" on OAuth session expired', async () => {
    mockedInvoke.mockResolvedValueOnce(null);
    const t = makeTarget({ picoraAuthRef: { kind: 'oauth', accountId: 'a' } });
    await expect(getPicoraApiKeyOrEmpty(t)).resolves.toBe('');
  });
});

describe('setPicoraApiKey', () => {
  it('calls keychain_set with prefixed key', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);
    await setPicoraApiKey('tg-1', 'sk_new');
    expect(mockedInvoke).toHaveBeenCalledWith('keychain_set', {
      key: 'picora-api-key:tg-1',
      value: 'sk_new',
    });
  });

  it('empty value triggers keychain_delete', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);
    await setPicoraApiKey('tg-1', '');
    expect(mockedInvoke).toHaveBeenCalledWith('keychain_delete', { key: 'picora-api-key:tg-1' });
  });

  it('subsequent get() picks up newly-set value from cache (no extra invoke)', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined); // for set
    await setPicoraApiKey('tg-1', 'sk_warm');

    mockedInvoke.mockClear();
    const t = makeTarget({ id: 'tg-1', picoraApiKey: '' });
    expect(await getPicoraApiKey(t)).toBe('sk_warm');
    expect(mockedInvoke).not.toHaveBeenCalled();
  });
});

describe('migratePicoraKeysToKeychain', () => {
  it('moves inline keys to keychain and reports counts', async () => {
    mockedInvoke.mockResolvedValue(undefined);
    const targets = [
      makeTarget({ id: 'a', picoraApiKey: 'k-a' }),
      makeTarget({ id: 'b', picoraApiKey: 'k-b' }),
      makeTarget({ id: 'c', picoraApiKey: '' }),  // skip: empty
    ];
    const { report, migratedIds } = await migratePicoraKeysToKeychain(targets);
    expect(report.migrated).toBe(2);
    expect(report.skipped).toBe(1);
    expect(report.errors).toEqual([]);
    expect(migratedIds).toEqual(['a', 'b']);
  });

  it('counts already-migrated targets separately', async () => {
    const targets = [
      makeTarget({ id: 'a', picoraApiKey: '', picoraKeyMigratedV069: true }),
    ];
    const { report } = await migratePicoraKeysToKeychain(targets);
    expect(report.alreadyMigrated).toBe(1);
    expect(report.migrated).toBe(0);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it('skips non-picora providers', async () => {
    const t = makeTarget({ provider: 'smms', picoraApiKey: 'should-not-touch' });
    const { report } = await migratePicoraKeysToKeychain([t]);
    expect(report.skipped).toBe(1);
    expect(report.migrated).toBe(0);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it('collects per-target errors without aborting batch', async () => {
    mockedInvoke
      .mockResolvedValueOnce(undefined)         // a: success
      .mockRejectedValueOnce(new Error('boom')) // b: fails
      .mockResolvedValueOnce(undefined);        // c: success
    const targets = [
      makeTarget({ id: 'a', picoraApiKey: 'ka' }),
      makeTarget({ id: 'b', picoraApiKey: 'kb' }),
      makeTarget({ id: 'c', picoraApiKey: 'kc' }),
    ];
    const { report, migratedIds } = await migratePicoraKeysToKeychain(targets);
    expect(report.migrated).toBe(2);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatchObject({ targetId: 'b', error: 'boom' });
    expect(migratedIds).toEqual(['a', 'c']);
  });

  it('is idempotent — second run with already-flagged targets is a no-op for invoke', async () => {
    mockedInvoke.mockResolvedValue(undefined);
    const targets = [
      makeTarget({ id: 'a', picoraApiKey: '', picoraKeyMigratedV069: true }),
      makeTarget({ id: 'b', picoraApiKey: '', picoraKeyMigratedV069: true }),
    ];
    await migratePicoraKeysToKeychain(targets);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });
});
