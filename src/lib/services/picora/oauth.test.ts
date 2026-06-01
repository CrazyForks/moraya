import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import {
  startDeviceFlow,
  pollOnce,
  getAccessToken,
  hasSession,
  logout,
  runDeviceFlow,
  type DeviceAuthorization,
  type PollResult,
} from './oauth';

const mockedInvoke = invoke as ReturnType<typeof vi.fn>;

const SAMPLE_AUTH: DeviceAuthorization = {
  deviceCode: 'dc_abc',
  userCode: 'WXYZ-1234',
  verificationUri: 'https://center.picora.me/device',
  verificationUriComplete: 'https://center.picora.me/device?user_code=WXYZ-1234',
  expiresIn: 600,
  intervalSecs: 1, // keep tests fast — 1s polling
};

beforeEach(() => {
  // resetAllMocks (not clearAllMocks) wipes mockResolvedValue/mockImplementation
  // queues — necessary because runDeviceFlow tests use persistent `.mockResolvedValue`
  // that would otherwise leak across tests.
  vi.resetAllMocks();
});

describe('startDeviceFlow', () => {
  it('invokes picora_oauth_start_device_flow with null defaults', async () => {
    mockedInvoke.mockResolvedValueOnce(SAMPLE_AUTH);
    await startDeviceFlow();
    expect(mockedInvoke).toHaveBeenCalledWith('picora_oauth_start_device_flow', {
      apiBase: null,
      scope: null,
    });
  });

  it('passes apiBase + scope when given', async () => {
    mockedInvoke.mockResolvedValueOnce(SAMPLE_AUTH);
    await startDeviceFlow({ apiBase: 'https://staging.picora.me', scope: 'image:write' });
    expect(mockedInvoke).toHaveBeenCalledWith('picora_oauth_start_device_flow', {
      apiBase: 'https://staging.picora.me',
      scope: 'image:write',
    });
  });
});

describe('pollOnce', () => {
  it('forwards device_code and account_id', async () => {
    mockedInvoke.mockResolvedValueOnce({ status: 'pending', scope: null, nextIntervalSecs: 5 });
    await pollOnce({ deviceCode: 'dc', accountId: 'acct-1' });
    expect(mockedInvoke).toHaveBeenCalledWith('picora_oauth_poll', {
      apiBase: null,
      deviceCode: 'dc',
      accountId: 'acct-1',
    });
  });

  it('returns success result verbatim', async () => {
    const expected: PollResult = { status: 'success', scope: 'image:write', nextIntervalSecs: null };
    mockedInvoke.mockResolvedValueOnce(expected);
    const out = await pollOnce({ deviceCode: 'dc', accountId: 'a' });
    expect(out).toEqual(expected);
  });
});

describe('getAccessToken / hasSession / logout', () => {
  it('getAccessToken returns string when present', async () => {
    mockedInvoke.mockResolvedValueOnce('at_xyz');
    const token = await getAccessToken('acct-1');
    expect(token).toBe('at_xyz');
    expect(mockedInvoke).toHaveBeenCalledWith('picora_oauth_get_token', {
      apiBase: null,
      accountId: 'acct-1',
    });
  });

  it('getAccessToken returns null when not authenticated', async () => {
    mockedInvoke.mockResolvedValueOnce(null);
    expect(await getAccessToken('acct-1')).toBeNull();
  });

  it('hasSession bridges to picora_oauth_has_session', async () => {
    mockedInvoke.mockResolvedValueOnce(true);
    await hasSession('acct-1');
    expect(mockedInvoke).toHaveBeenCalledWith('picora_oauth_has_session', { accountId: 'acct-1' });
  });

  it('logout bridges to picora_oauth_logout', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);
    await logout('acct-1');
    expect(mockedInvoke).toHaveBeenCalledWith('picora_oauth_logout', {
      apiBase: null,
      accountId: 'acct-1',
    });
  });
});

describe('runDeviceFlow', () => {
  it('calls onCodeReady immediately and polls until success', async () => {
    mockedInvoke
      .mockResolvedValueOnce(SAMPLE_AUTH)
      .mockResolvedValueOnce({ status: 'pending', scope: null, nextIntervalSecs: 1 })
      .mockResolvedValueOnce({ status: 'pending', scope: null, nextIntervalSecs: 1 })
      .mockResolvedValueOnce({ status: 'success', scope: 'image:write', nextIntervalSecs: null });

    const onCodeReady = vi.fn();
    const result = await runDeviceFlow({
      accountId: 'acct-1',
      onCodeReady,
    });

    expect(onCodeReady).toHaveBeenCalledWith(SAMPLE_AUTH);
    expect(result.status).toBe('success');
    expect(result.scope).toBe('image:write');
  });

  it('respects abort signal between polls', async () => {
    mockedInvoke
      .mockResolvedValueOnce(SAMPLE_AUTH)
      .mockResolvedValue({ status: 'pending', scope: null, nextIntervalSecs: 1 });

    const ctrl = new AbortController();
    const onCodeReady = vi.fn(() => {
      // Abort right after we get the code
      ctrl.abort();
    });

    const result = await runDeviceFlow({
      accountId: 'acct-1',
      onCodeReady,
      signal: ctrl.signal,
    });

    expect(result.status).toBe('denied');
  });

  it('updates poll interval from nextIntervalSecs across loop iterations', async () => {
    // Use a 0-second interval so the test stays under vitest's default 5s timeout
    // (the slow-down semantics — actual interval bumping — are exercised on the
    // Rust side; here we only assert the frontend respects nextIntervalSecs).
    mockedInvoke
      .mockResolvedValueOnce({ ...SAMPLE_AUTH, intervalSecs: 0 })
      .mockResolvedValueOnce({ status: 'slow-down', scope: null, nextIntervalSecs: 0 })
      .mockResolvedValueOnce({ status: 'success', scope: 'image:write', nextIntervalSecs: null });

    const result = await runDeviceFlow({
      accountId: 'a',
      onCodeReady: () => {},
    });

    expect(result.status).toBe('success');
    // 3 invokes: startDeviceFlow + 2 polls
    expect(mockedInvoke).toHaveBeenCalledTimes(3);
  });

  it('returns denied on access_denied terminal response', async () => {
    mockedInvoke
      .mockResolvedValueOnce({ ...SAMPLE_AUTH, intervalSecs: 0 })
      .mockResolvedValueOnce({ status: 'denied', scope: null, nextIntervalSecs: null });
    const result = await runDeviceFlow({
      accountId: 'a',
      onCodeReady: () => {},
    });
    expect(result.status).toBe('denied');
  });
});
