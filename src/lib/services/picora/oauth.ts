/**
 * Picora OAuth Device Flow client (frontend) — v0.66.0 Phase A.
 *
 * Wraps the Rust commands in `src-tauri/src/commands/picora_oauth.rs`. The
 * Rust side owns:
 *   - HTTP calls to Picora OAuth endpoints
 *   - Token persistence under Keychain key `picora-token:{accountId}`
 *   - Auto-refresh when access_token is near expiry
 *
 * Frontend responsibilities:
 *   - Drive the polling loop (Rust returns one poll per invoke; UI controls
 *     pacing using `nextIntervalSecs` returned per call)
 *   - Open the verification URL in the user's browser
 *   - Track which Moraya `account_id` maps to which Picora account
 */

import { invoke } from '@tauri-apps/api/core';

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresIn: number;
  intervalSecs: number;
}

export type PollStatus = 'success' | 'pending' | 'slow-down' | 'denied' | 'expired';

export interface PollResult {
  status: PollStatus;
  scope: string | null;
  nextIntervalSecs: number | null;
}

/**
 * Reference to a Picora authentication credential. Exists as a single-kind
 * type today; v0.69.0 Phase 2 will add `{ kind: 'api-key', targetId }` to
 * unify with the legacy path.
 */
export type AuthRef = { kind: 'oauth'; accountId: string };

/**
 * Begin the OAuth Device Flow. Returns codes/URLs the UI must display.
 *
 * @param scope override the default scope list (image:write video:write kb:write)
 */
export async function startDeviceFlow(opts?: {
  apiBase?: string;
  scope?: string;
}): Promise<DeviceAuthorization> {
  return invoke<DeviceAuthorization>('picora_oauth_start_device_flow', {
    apiBase: opts?.apiBase ?? null,
    scope: opts?.scope ?? null,
  });
}

/**
 * Single poll attempt. Frontend should schedule next call after
 * `nextIntervalSecs` seconds when status is `pending` or `slow-down`.
 * On `success`, tokens are persisted to keychain under `accountId`.
 */
export async function pollOnce(opts: {
  apiBase?: string;
  deviceCode: string;
  accountId: string;
}): Promise<PollResult> {
  return invoke<PollResult>('picora_oauth_poll', {
    apiBase: opts.apiBase ?? null,
    deviceCode: opts.deviceCode,
    accountId: opts.accountId,
  });
}

/**
 * Return a Bearer-ready access token for the account; auto-refreshes
 * if the cached token is near expiry. Returns null when the account
 * is not authenticated or the refresh token has been revoked.
 */
export async function getAccessToken(accountId: string, apiBase?: string): Promise<string | null> {
  return invoke<string | null>('picora_oauth_get_token', {
    apiBase: apiBase ?? null,
    accountId,
  });
}

/** Whether the given accountId has stored tokens. Does NOT refresh. */
export async function hasSession(accountId: string): Promise<boolean> {
  return invoke<boolean>('picora_oauth_has_session', { accountId });
}

/** Sign out: clears local tokens and (best-effort) revokes at Picora. */
export async function logout(accountId: string, apiBase?: string): Promise<void> {
  await invoke('picora_oauth_logout', {
    apiBase: apiBase ?? null,
    accountId,
  });
}

/**
 * Higher-level orchestrator: kicks off a device flow + polls until
 * terminal. Returns the verification info immediately via `onCodeReady`
 * so the UI can render the user_code before the loop completes.
 *
 * Implementation note: polling is driven by `nextIntervalSecs` returned
 * by the Rust side, which handles RFC 8628 slow_down responses by bumping
 * the interval. The frontend is responsible only for the sleep + abort.
 */
export async function runDeviceFlow(opts: {
  accountId: string;
  apiBase?: string;
  scope?: string;
  onCodeReady: (auth: DeviceAuthorization) => void;
  signal?: AbortSignal;
}): Promise<PollResult> {
  const auth = await startDeviceFlow({ apiBase: opts.apiBase, scope: opts.scope });
  opts.onCodeReady(auth);

  let interval = auth.intervalSecs;
  const deadline = Date.now() + auth.expiresIn * 1000;
  let isFirstPoll = true;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      return { status: 'denied', scope: null, nextIntervalSecs: null };
    }
    // First poll is eager — most flows complete near-instantly once the user
    // approves in the browser. Sleeping for `interval` first would add up to
    // `interval` seconds of UI lag for no benefit. RFC 8628 §3.5 only requires
    // ≥`interval` between polls, not before the first.
    if (!isFirstPoll) {
      await sleepWithAbort(interval * 1000, opts.signal);
      if (opts.signal?.aborted) {
        return { status: 'denied', scope: null, nextIntervalSecs: null };
      }
    }
    isFirstPoll = false;
    const result = await pollOnce({
      apiBase: opts.apiBase,
      deviceCode: auth.deviceCode,
      accountId: opts.accountId,
    });
    if (result.status === 'success' || result.status === 'denied' || result.status === 'expired') {
      return result;
    }
    if (result.nextIntervalSecs) {
      interval = result.nextIntervalSecs;
    }
  }

  return { status: 'expired', scope: null, nextIntervalSecs: null };
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    }
  });
}
