# Cloud-Sync Entitlement Gate — Two-Layer Spec

> Status: Layer 2 (client) implemented in moraya-web + moraya (PC) + moraya-mobile.
> Layer 1 (Picora server) is specified here for the `picora-service` / `picora-center` repos to implement.

## Goal

A user who signs in to Picora but has **no active paid plan** must not use KB cloud sync. The client falls back to pure local/offline use. Two independent layers enforce this:

1. **Layer 1 — Picora API gate (server, authoritative).** Reject KB-sync writes/reads from unentitled accounts. This is the source of truth; the client cannot be trusted.
2. **Layer 2 — client pre-check (UX).** The client checks entitlement *before* firing sync requests, so a plan-less account never sends a wall of requests that Layer 1 would reject (mass 4xx tanks perceived performance). The client silently uses the local adapter instead.

This doc pins the contract between the two so they agree.

## Entitlement rule

- **Unentitled = the free / unactivated tier.** In Picora's usage payload today that is `plan === "none"`; via web OAuth userinfo it is `plan === "free"`. Any paid tier (`trial` / `pro` / `pro_plus`, or web's `pro` / `team`) is entitled.
- Entitled ⇔ `plan is a paid tier` **and** (where an expiry is known) `not expired`.

### ⚠ Cross-client inconsistency to fix (server-side)

The two clients read the plan from **different endpoints with different vocabularies**:

| Client | Source | `plan` values | Expiry field |
|---|---|---|---|
| Web / Mobile | OAuth `/oauth/userinfo` | `free` \| `pro` \| `team` | `plan_expires_at` (present) |
| Desktop (PC) | `GET /v1/user/me/usage` | `none` \| `trial` \| `pro` \| `pro_plus` | **absent** |

**Requests to picora-service:**
1. **Harmonize the plan vocabulary** across `/oauth/userinfo` and `/v1/user/me/usage` (single canonical set), or document a stable mapping.
2. **Add `expiresAt` (or `planExpiresAt`) to `/v1/user/me/usage`** so the desktop gate can check expiry, not just the plan name. Until then, PC gates on plan-name only.

## Layer 1 — endpoints to gate (server)

Reject when the caller's account is unentitled:

| Endpoint | Op | Why |
|---|---|---|
| `POST /v1/kbs/:kbId/sync` | upsert / move / delete | The core KB-sync write path (all document sync). |
| `POST /v1/kbs` | create KB | New cloud KB requires a plan. |
| `GET /v1/kbs/:kbId/manifest` | read manifest | Part of the sync round-trip. Gate to prevent probing. |
| `GET /v1/docs/:docId/raw`, `POST /v1/docs/raw:batch` | read doc bodies | Cloud content reads. |
| Media hosting write endpoints (`POST /v1/media…`, image/video upload) | write | Same plan boundary. |

### Rejection contract

Return **HTTP 403** with a stable machine-readable body so the client can distinguish "no plan" from other failures:

```json
{
  "success": false,
  "error": {
    "code": "PLAN_REQUIRED",
    "message": "An active plan is required for cloud sync.",
    "plan": "none"
  }
}
```

- `code: "PLAN_REQUIRED"` is the contract the client keys on (do not fold into a generic 402/403).
- Include the current `plan` so the client can show an accurate upgrade CTA.

## Layer 1 — endpoints that MUST NOT be gated

Gating these would make it impossible to view one's plan or subscribe:

- `POST /oauth/token`, `GET /oauth/userinfo`, `POST /oauth/revoke`, the device-flow endpoints.
- `GET /v1/user/me/usage` (the plan/quota query itself).
- All billing endpoints (checkout / portal / entitlement / invoices / subscription management) — these live on `api.moraya.app`, not Picora, but noted for completeness.

## Layer 2 — client implementation (done)

**Single source of truth per platform:**
- Web/Mobile: `moraya-web/src/lib/billing/cloud-entitlement.ts` — `hasActiveCloudPlan()` = `plan !== 'free' && planExpiresAt > now` (reads `PicoraSession`).
- PC: `moraya/src/lib/services/picora/entitlement.ts` — `isKbSyncEntitled(plan)` = `plan !== 'none'`, with a 60s-cached `getPicoraPlan(target)` over `picora_get_quota`. Fail-closed on first lookup error (no cache → treat as unentitled); reuse last known plan on a later transient error.

**Interception points (fall back to the local adapter, no cloud request):**
- Web: `kb-browse.ts loadKbList()` (source — plan-less session lists only the local IndexedDB workspace, so cloud KBs never enter any code path), `edit/[tabId]/+page.svelte ensureAdapter()` (belt-and-suspenders), and the AI-conversation / memory / insert-to-note / mentions / compose-cover adapter selectors.
- PC: `sync-service.ts runSync()` engine-level hard gate (covers all 6 triggers: manual / on-save / interval / startup / close / conflict re-sync) + `applyResolvedContent()` (keeps the local write, skips the upload). The gate surfaces its reason through the existing `kbSyncStore` error channel (`kb_sync.gate.no_plan`), which the KB-sync settings / sidebar / status ⚠ already display.

The client gate is defense + UX; **Layer 1 remains authoritative** and must reject unentitled requests regardless of client behavior.

## Test coverage (client)

- Web: `cloud-entitlement.test.ts` (plan/expiry truth table).
- PC: `entitlement.test.ts` (judgment + cache + fail-closed), `sync-service.test.ts` (runSync blocks with no plan → no `fetchManifest`/`syncBatch`, error state carries the reason; dry-run idle; trial/pro allowed).
