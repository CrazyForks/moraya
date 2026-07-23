import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('$lib/services/picora/credentials', () => ({
  getPicoraApiKeyOrEmpty: vi.fn().mockResolvedValue('key'),
}));

import { invoke } from '@tauri-apps/api/core';
import {
  isKbSyncEntitled,
  getPicoraPlan,
  invalidatePlanCache,
  UNENTITLED_PLAN,
} from './entitlement';
import type { ImageHostTarget } from '$lib/services/image-hosting/types';

function target(id = 't1'): ImageHostTarget {
  return { id, picoraApiUrl: 'https://api.picora.me' } as unknown as ImageHostTarget;
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidatePlanCache();
});

describe('isKbSyncEntitled', () => {
  it('denies the free/unactivated tier and empty values', () => {
    expect(isKbSyncEntitled(UNENTITLED_PLAN)).toBe(false);
    expect(isKbSyncEntitled('none')).toBe(false);
    expect(isKbSyncEntitled('')).toBe(false);
    expect(isKbSyncEntitled(null)).toBe(false);
    expect(isKbSyncEntitled(undefined)).toBe(false);
  });

  it('grants trial / pro / pro_plus', () => {
    expect(isKbSyncEntitled('trial')).toBe(true);
    expect(isKbSyncEntitled('pro')).toBe(true);
    expect(isKbSyncEntitled('pro_plus')).toBe(true);
  });
});

describe('getPicoraPlan', () => {
  it('fetches the plan from picora_get_quota', async () => {
    vi.mocked(invoke).mockResolvedValue({ plan: 'pro' });
    expect(await getPicoraPlan(target())).toBe('pro');
    expect(invoke).toHaveBeenCalledWith('picora_get_quota', expect.objectContaining({ apiKey: 'key' }));
  });

  it('caches within the TTL — a second call does not refetch', async () => {
    vi.mocked(invoke).mockResolvedValue({ plan: 'pro' });
    await getPicoraPlan(target());
    await getPicoraPlan(target());
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('treats an absent plan field as unentitled', async () => {
    vi.mocked(invoke).mockResolvedValue({});
    expect(await getPicoraPlan(target())).toBe(UNENTITLED_PLAN);
  });

  it('fails closed to unentitled when the lookup errors with no cache', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('offline'));
    expect(await getPicoraPlan(target())).toBe(UNENTITLED_PLAN);
  });

  it('invalidatePlanCache forces a refetch', async () => {
    vi.mocked(invoke).mockResolvedValue({ plan: 'pro' });
    await getPicoraPlan(target());
    invalidatePlanCache();
    await getPicoraPlan(target());
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
