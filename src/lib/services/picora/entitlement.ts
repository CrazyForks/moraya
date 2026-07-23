// Cloud-sync entitlement gate (PC).
//
// Product rule: signing in to Picora is not enough to sync a knowledge base to
// the cloud — the account must be on an active paid plan. A plan-less account
// works purely against local files/offline; the client must NOT fire KB-sync
// requests that Picora's server-side plan gate would reject (a wall of failing
// requests tanks perceived performance). Subscribing restores cloud sync.
//
// The signal is `PicoraQuota.plan` from `GET /v1/user/me/usage` (via the Rust
// `picora_get_quota` command). `'none'` (or absent) = the free/unactivated tier
// → no cloud sync. `trial | pro | pro_plus` grant it.
//
// Note: the usage endpoint currently returns NO subscription-expiry field, so
// this gate is plan-name only. If Picora adds `expiresAt`, extend the check
// (see docs/specs/entitlement-cloud-sync-gate.md).

import { invoke } from '@tauri-apps/api/core';
import type { ImageHostTarget } from '$lib/services/image-hosting/types';

/** Free / unactivated tier — the one plan value that denies cloud sync. */
export const UNENTITLED_PLAN = 'none';

/** Whether a plan value grants KB cloud sync. Empty/unknown → denied. */
export function isKbSyncEntitled(plan: string | null | undefined): boolean {
  return !!plan && plan !== UNENTITLED_PLAN;
}

interface PlanCacheEntry {
  plan: string;
  at: number;
}

const PLAN_TTL_MS = 60_000;
const planCache = new Map<string, PlanCacheEntry>();

function picoraApiBase(target: ImageHostTarget): string {
  const url = (target.picoraApiUrl || '').trim();
  if (!url) return 'https://api.picora.me';
  return url.replace(/\/v1\/images\/?$/, '').replace(/\/$/, '') || 'https://api.picora.me';
}

/**
 * Resolve the account's current plan for `target`, cached with a short TTL so a
 * burst of sync triggers (on-save + interval + manual) doesn't spam the usage
 * endpoint. Fail-closed on the FIRST lookup error (no cache → `'none'` → sync
 * stays blocked, content stays safe locally); on a later transient error the
 * last known plan is reused so a paid user isn't locked out by a blip.
 */
export async function getPicoraPlan(target: ImageHostTarget): Promise<string> {
  const cached = planCache.get(target.id);
  if (cached && Date.now() - cached.at < PLAN_TTL_MS) return cached.plan;
  try {
    const apiBase = picoraApiBase(target);
    const { getPicoraApiKeyOrEmpty } = await import('$lib/services/picora/credentials');
    const apiKey = await getPicoraApiKeyOrEmpty(target);
    const data = await invoke<{ plan?: string }>('picora_get_quota', { apiBase, apiKey });
    const plan = data.plan || UNENTITLED_PLAN;
    planCache.set(target.id, { plan, at: Date.now() });
    return plan;
  } catch {
    return cached?.plan ?? UNENTITLED_PLAN;
  }
}

/** Convenience: fetch the plan and apply the entitlement rule. */
export async function isTargetKbSyncEntitled(target: ImageHostTarget): Promise<boolean> {
  return isKbSyncEntitled(await getPicoraPlan(target));
}

/** Drop a cached plan (e.g. after the user subscribes) so the next check refetches. */
export function invalidatePlanCache(targetId?: string): void {
  if (targetId) planCache.delete(targetId);
  else planCache.clear();
}
