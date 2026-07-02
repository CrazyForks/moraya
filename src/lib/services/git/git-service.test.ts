import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import { checkGitInstalled, __resetGitInstalledCache } from './git-service';

const mockedInvoke = invoke as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  __resetGitInstalledCache();
});

describe('checkGitInstalled', () => {
  it('returns the backend result', async () => {
    mockedInvoke.mockResolvedValueOnce(true);
    await expect(checkGitInstalled()).resolves.toBe(true);
    expect(mockedInvoke).toHaveBeenCalledWith('git_check_installed');
  });

  it('memoizes the result so the IPC is invoked only once across calls', async () => {
    mockedInvoke.mockResolvedValueOnce(true);
    const a = await checkGitInstalled();
    const b = await checkGitInstalled();
    const c = await checkGitInstalled();
    expect([a, b, c]).toEqual([true, true, true]);
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent callers onto a single in-flight probe', async () => {
    let resolveInvoke: (v: boolean) => void = () => {};
    mockedInvoke.mockReturnValueOnce(
      new Promise<boolean>((resolve) => { resolveInvoke = resolve; }),
    );
    const p1 = checkGitInstalled();
    const p2 = checkGitInstalled();
    resolveInvoke(false);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(false);
    expect(r2).toBe(false);
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
  });

  it('does not cache a rejected probe — a later call retries', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('spawn failed'));
    await expect(checkGitInstalled()).rejects.toThrow('spawn failed');
    // Cache stayed empty, so the next call re-issues the IPC.
    mockedInvoke.mockResolvedValueOnce(true);
    await expect(checkGitInstalled()).resolves.toBe(true);
    expect(mockedInvoke).toHaveBeenCalledTimes(2);
  });
});
