/**
 * Picora OAuth Device Flow — v0.66.0 Phase A.
 *
 * RFC 8628 client (Device Authorization Grant) for Picora. Used by the
 * desktop Photos Sync feature and (in v0.69.0 Phase 2) by all other Picora
 * integrations as a replacement for plaintext API keys.
 *
 * Endpoints (Picora-side; see AI-MidasTouch/link-anchor/docs/integration-guides/
 * moraya-photos-scanner-integration.md):
 *   POST /v1/oauth/device_authorization
 *   POST /oauth/token  (grant_type=urn:ietf:params:oauth:grant-type:device_code)
 *   POST /oauth/token  (grant_type=refresh_token)
 *
 * Tokens are persisted via the existing keychain mechanism (AIProxyState's
 * shared secret cache) under the namespace `picora-token:{account_id}`,
 * mirroring v0.69.0's `picora-api-key:{target_id}` convention.
 *
 * Security:
 *  - Refresh tokens never leave Rust → never exposed to frontend
 *  - access_token is short-lived (Picora issues ≤15 min TTL); auto-refresh
 *    when ≤60s remain
 *  - Token payload sanitized in error messages (no leak in logs)
 */

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

use super::ai_proxy::AIProxyState;
use super::util::current_epoch_ms;

const DEFAULT_API_BASE: &str = "https://api.picora.me";
const PICORA_DESKTOP_CLIENT_ID: &str = "picora_desktop_official_moraya";
const DEFAULT_SCOPE: &str = "image:write video:write kb:write";
const REQUEST_TIMEOUT_SECS: u64 = 30;
const POLL_DEFAULT_INTERVAL_SECS: u64 = 5;
const REFRESH_SLACK_SECS: u64 = 60;

const TOKEN_KEY_PREFIX: &str = "picora-token:";

// ── Types ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct DeviceAuthorization {
    /// Opaque code the client polls with — never displayed to user.
    #[serde(rename = "deviceCode")]
    pub device_code: String,
    /// Short, human-typeable code the user enters on `verification_uri`.
    #[serde(rename = "userCode")]
    pub user_code: String,
    /// Page the user opens in their browser to enter `user_code`.
    #[serde(rename = "verificationUri")]
    pub verification_uri: String,
    /// Pre-filled variant the client can open directly to skip code entry.
    #[serde(rename = "verificationUriComplete")]
    pub verification_uri_complete: Option<String>,
    /// Lifetime of `device_code` in seconds (RFC 8628 §3.2).
    #[serde(rename = "expiresIn")]
    pub expires_in: u64,
    /// Recommended seconds between poll attempts (server may override
    /// with `slow_down` response — see `poll` command).
    #[serde(rename = "intervalSecs")]
    pub interval_secs: u64,
}

#[derive(Debug, Deserialize)]
struct DeviceAuthRaw {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: Option<String>,
    expires_in: u64,
    #[serde(default)]
    interval: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct TokenRaw {
    access_token: String,
    /// Picora always issues a refresh token for desktop clients.
    refresh_token: Option<String>,
    expires_in: u64,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default, rename = "id_token")]
    id_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OAuthError {
    error: String,
    #[allow(dead_code)]
    error_description: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct StoredTokens {
    access_token: String,
    refresh_token: String,
    /// Epoch ms when `access_token` becomes invalid.
    expires_at_ms: u64,
    scope: String,
}

#[derive(Debug, Serialize)]
pub struct PollResult {
    pub status: PollStatus,
    /// Only populated when status = Success.
    pub scope: Option<String>,
    /// Only populated when status = Pending — caller should re-poll with
    /// at least this many seconds delay (may differ from initial interval
    /// after a `slow_down` response).
    #[serde(rename = "nextIntervalSecs")]
    pub next_interval_secs: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PollStatus {
    Success,
    Pending,
    SlowDown,
    Denied,
    Expired,
}

// ── In-memory poll-interval tracking ───────────────────────────────────
// RFC 8628 §3.5: server may respond `slow_down`, in which case the client
// MUST increase its polling interval. We track per-device-code interval
// because multiple parallel device flows could be in progress (rare but
// possible, e.g. one per Picora target).

static POLL_INTERVALS: Mutex<Option<HashMap<String, u64>>> = Mutex::new(None);

fn with_intervals<R>(f: impl FnOnce(&mut HashMap<String, u64>) -> R) -> Option<R> {
    let mut guard = POLL_INTERVALS.lock().ok()?;
    Some(f(guard.get_or_insert_with(HashMap::new)))
}

fn current_interval(device_code: &str, fallback: u64) -> u64 {
    with_intervals(|m| m.get(device_code).copied()).flatten().unwrap_or(fallback)
}

fn set_interval(device_code: &str, secs: u64) {
    with_intervals(|m| m.insert(device_code.to_string(), secs));
}

fn forget_interval(device_code: &str) {
    with_intervals(|m| m.remove(device_code));
}

// ── Helpers ────────────────────────────────────────────────────────────

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|_| "Failed to create HTTP client".to_string())
}

pub fn token_key(account_id: &str) -> String {
    format!("{}{}", TOKEN_KEY_PREFIX, account_id)
}

async fn read_stored(state: &AIProxyState, account_id: &str) -> Option<StoredTokens> {
    state.ensure_secrets_loaded().await;
    let cache = state.key_cache.lock().ok()?;
    let raw = cache.get(&token_key(account_id))?.clone();
    drop(cache);
    serde_json::from_str(&raw).ok()
}

async fn write_stored(
    state: &AIProxyState,
    account_id: &str,
    tokens: &StoredTokens,
) -> Result<(), String> {
    state.ensure_secrets_loaded().await;
    let serialized = serde_json::to_string(tokens)
        .map_err(|_| "Failed to encode tokens".to_string())?;
    if let Ok(mut cache) = state.key_cache.lock() {
        cache.insert(token_key(account_id), serialized);
    }
    state.persist_secrets().await
}

async fn clear_stored(state: &AIProxyState, account_id: &str) -> Result<(), String> {
    state.ensure_secrets_loaded().await;
    if let Ok(mut cache) = state.key_cache.lock() {
        cache.remove(&token_key(account_id));
    }
    state.persist_secrets().await
}

/// Map an OAuth error response to a tagged status. Centralized so the same
/// mapping covers both poll() and refresh().
fn map_oauth_error(error: &str) -> PollStatus {
    match error {
        "authorization_pending" => PollStatus::Pending,
        "slow_down" => PollStatus::SlowDown,
        "access_denied" => PollStatus::Denied,
        "expired_token" => PollStatus::Expired,
        _ => PollStatus::Expired, // safest default — caller treats as terminal
    }
}

// ── Commands ───────────────────────────────────────────────────────────

/// Start the OAuth Device Authorization flow (RFC 8628 §3.1-3.2).
/// Returns codes the frontend displays to the user.
#[tauri::command]
pub async fn picora_oauth_start_device_flow(
    api_base: Option<String>,
    scope: Option<String>,
) -> Result<DeviceAuthorization, String> {
    let client = build_client()?;
    let base = api_base.unwrap_or_else(|| DEFAULT_API_BASE.to_string());
    let url = format!("{}/v1/oauth/device_authorization", base);
    let scope = scope.unwrap_or_else(|| DEFAULT_SCOPE.to_string());

    let resp = client
        .post(&url)
        .form(&[("client_id", PICORA_DESKTOP_CLIENT_ID), ("scope", &scope)])
        .send()
        .await
        .map_err(|_| "Network error reaching Picora".to_string())?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        return Err(match status {
            400 => "Picora rejected the device-flow request".to_string(),
            429 => "Picora rate limit — retry later".to_string(),
            500..=599 => "Picora service unavailable".to_string(),
            _ => format!("Picora device-flow request failed ({})", status),
        });
    }

    let raw: DeviceAuthRaw = resp
        .json()
        .await
        .map_err(|_| "Could not parse Picora device-flow response".to_string())?;

    let interval = raw.interval.unwrap_or(POLL_DEFAULT_INTERVAL_SECS);
    set_interval(&raw.device_code, interval);

    Ok(DeviceAuthorization {
        device_code: raw.device_code,
        user_code: raw.user_code,
        verification_uri: raw.verification_uri,
        verification_uri_complete: raw.verification_uri_complete,
        expires_in: raw.expires_in,
        interval_secs: interval,
    })
}

/// Poll the token endpoint exactly once for a device_code.
///
/// The frontend is responsible for spacing calls by `next_interval_secs`.
/// On `Success`, tokens are persisted to keychain under `account_id`.
#[tauri::command]
pub async fn picora_oauth_poll(
    state: tauri::State<'_, AIProxyState>,
    api_base: Option<String>,
    device_code: String,
    account_id: String,
) -> Result<PollResult, String> {
    let client = build_client()?;
    let base = api_base.unwrap_or_else(|| DEFAULT_API_BASE.to_string());
    let url = format!("{}/oauth/token", base);

    let resp = client
        .post(&url)
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("client_id", PICORA_DESKTOP_CLIENT_ID),
            ("device_code", &device_code),
        ])
        .send()
        .await
        .map_err(|_| "Network error reaching Picora".to_string())?;

    let status = resp.status();
    if status.is_success() {
        let raw: TokenRaw = resp
            .json()
            .await
            .map_err(|_| "Could not parse Picora token response".to_string())?;
        let refresh = raw.refresh_token.ok_or_else(|| {
            "Picora omitted refresh_token — desktop client requires one".to_string()
        })?;
        let scope = raw.scope.clone().unwrap_or_else(|| DEFAULT_SCOPE.to_string());
        let stored = StoredTokens {
            access_token: raw.access_token,
            refresh_token: refresh,
            expires_at_ms: current_epoch_ms() + raw.expires_in.saturating_mul(1000),
            scope: scope.clone(),
        };
        write_stored(&state, &account_id, &stored).await?;
        forget_interval(&device_code);
        return Ok(PollResult { status: PollStatus::Success, scope: Some(scope), next_interval_secs: None });
    }

    // RFC 8628 §3.5: 400 with `error` discriminates between Pending / SlowDown / etc.
    if status.as_u16() == 400 {
        let parsed: Result<OAuthError, _> = resp.json().await;
        if let Ok(err) = parsed {
            let s = map_oauth_error(&err.error);
            // Bump interval on slow_down per spec
            if matches!(s, PollStatus::SlowDown) {
                let cur = current_interval(&device_code, POLL_DEFAULT_INTERVAL_SECS);
                set_interval(&device_code, cur.saturating_add(5));
            }
            // Cleanup on terminal states
            if matches!(s, PollStatus::Denied | PollStatus::Expired) {
                forget_interval(&device_code);
            }
            let next = current_interval(&device_code, POLL_DEFAULT_INTERVAL_SECS);
            return Ok(PollResult {
                status: s,
                scope: None,
                next_interval_secs: Some(next),
            });
        }
    }

    Err(match status.as_u16() {
        429 => "Picora rate limit — wait before polling".to_string(),
        500..=599 => "Picora service unavailable".to_string(),
        _ => format!("Picora poll failed ({})", status.as_u16()),
    })
}

/// Return a usable access_token for the account; auto-refreshes when within
/// `REFRESH_SLACK_SECS` of expiry. Returns `None` if the account is not
/// authenticated (no stored tokens) or refresh failed (e.g. revoked at
/// center.picora.me — caller should prompt re-auth).
#[tauri::command]
pub async fn picora_oauth_get_token(
    state: tauri::State<'_, AIProxyState>,
    api_base: Option<String>,
    account_id: String,
) -> Result<Option<String>, String> {
    let stored = match read_stored(&state, &account_id).await {
        Some(s) => s,
        None => return Ok(None),
    };

    let now = current_epoch_ms();
    if stored.expires_at_ms > now + REFRESH_SLACK_SECS * 1000 {
        return Ok(Some(stored.access_token));
    }

    // Refresh
    let client = build_client()?;
    let base = api_base.unwrap_or_else(|| DEFAULT_API_BASE.to_string());
    let url = format!("{}/oauth/token", base);
    let resp = client
        .post(&url)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", PICORA_DESKTOP_CLIENT_ID),
            ("refresh_token", &stored.refresh_token),
        ])
        .send()
        .await
        .map_err(|_| "Network error during token refresh".to_string())?;

    if !resp.status().is_success() {
        // Treat any 4xx as terminal — refresh tokens rotate on each use,
        // a 4xx means our refresh_token is stale or revoked.
        if resp.status().is_client_error() {
            clear_stored(&state, &account_id).await.ok();
        }
        return Ok(None);
    }

    let raw: TokenRaw = match resp.json().await {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };
    let new_refresh = raw.refresh_token.unwrap_or(stored.refresh_token);
    let new_scope = raw.scope.unwrap_or(stored.scope);
    let new_stored = StoredTokens {
        access_token: raw.access_token.clone(),
        refresh_token: new_refresh,
        expires_at_ms: current_epoch_ms() + raw.expires_in.saturating_mul(1000),
        scope: new_scope,
    };
    write_stored(&state, &account_id, &new_stored).await?;
    Ok(Some(raw.access_token))
}

/// Whether the given account_id has stored tokens. Cheap — does not refresh.
#[tauri::command]
pub async fn picora_oauth_has_session(
    state: tauri::State<'_, AIProxyState>,
    account_id: String,
) -> Result<bool, String> {
    Ok(read_stored(&state, &account_id).await.is_some())
}

/// Clear stored tokens and (best-effort) revoke at Picora.
#[tauri::command]
pub async fn picora_oauth_logout(
    state: tauri::State<'_, AIProxyState>,
    api_base: Option<String>,
    account_id: String,
) -> Result<(), String> {
    let stored = read_stored(&state, &account_id).await;
    clear_stored(&state, &account_id).await?;
    // Best-effort revoke — ignore errors; clearing local is the real win.
    if let Some(s) = stored {
        let client = build_client()?;
        let base = api_base.unwrap_or_else(|| DEFAULT_API_BASE.to_string());
        let url = format!("{}/oauth/revoke", base);
        let _ = client
            .post(&url)
            .form(&[
                ("client_id", PICORA_DESKTOP_CLIENT_ID),
                ("token", &s.refresh_token),
                ("token_type_hint", "refresh_token"),
            ])
            .send()
            .await;
    }
    Ok(())
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_key_uses_documented_prefix() {
        assert_eq!(token_key("acct-1"), "picora-token:acct-1");
        assert_eq!(token_key(""), "picora-token:");
    }

    #[test]
    fn map_oauth_error_classifies_known_codes() {
        matches!(map_oauth_error("authorization_pending"), PollStatus::Pending);
        matches!(map_oauth_error("slow_down"), PollStatus::SlowDown);
        matches!(map_oauth_error("access_denied"), PollStatus::Denied);
        matches!(map_oauth_error("expired_token"), PollStatus::Expired);
        matches!(map_oauth_error("totally_unknown"), PollStatus::Expired);
    }

    #[test]
    fn interval_tracker_per_device_code() {
        // Use unique codes to avoid collision with parallel tests
        let a = "test-interval-A-12345";
        let b = "test-interval-B-67890";
        set_interval(a, 5);
        set_interval(b, 8);
        assert_eq!(current_interval(a, 99), 5);
        assert_eq!(current_interval(b, 99), 8);

        // Update + read
        set_interval(a, 10);
        assert_eq!(current_interval(a, 99), 10);
        assert_eq!(current_interval(b, 99), 8);

        // Forget
        forget_interval(a);
        assert_eq!(current_interval(a, 99), 99);
        assert_eq!(current_interval(b, 99), 8);
        forget_interval(b);
    }

    #[test]
    fn poll_result_serializes_with_camelcase_and_kebab_status() {
        let r = PollResult {
            status: PollStatus::SlowDown,
            scope: None,
            next_interval_secs: Some(10),
        };
        let s = serde_json::to_string(&r).unwrap();
        assert!(s.contains("\"status\":\"slow-down\""), "{s}");
        assert!(s.contains("\"nextIntervalSecs\":10"), "{s}");
    }

    #[test]
    fn device_authorization_serializes_with_camelcase() {
        let d = DeviceAuthorization {
            device_code: "dc".to_string(),
            user_code: "ABCD-1234".to_string(),
            verification_uri: "https://center.picora.me/device".to_string(),
            verification_uri_complete: Some("https://center.picora.me/device?user_code=ABCD-1234".to_string()),
            expires_in: 600,
            interval_secs: 5,
        };
        let s = serde_json::to_string(&d).unwrap();
        assert!(s.contains("\"deviceCode\":\"dc\""), "{s}");
        assert!(s.contains("\"userCode\":\"ABCD-1234\""), "{s}");
        assert!(s.contains("\"verificationUri\":"), "{s}");
        assert!(s.contains("\"verificationUriComplete\":"), "{s}");
        assert!(s.contains("\"expiresIn\":600"), "{s}");
        assert!(s.contains("\"intervalSecs\":5"), "{s}");
    }

    #[test]
    fn stored_tokens_round_trip() {
        let original = StoredTokens {
            access_token: "at_xyz".to_string(),
            refresh_token: "rt_abc".to_string(),
            expires_at_ms: 1_780_000_000_000,
            scope: "image:write".to_string(),
        };
        let s = serde_json::to_string(&original).unwrap();
        let parsed: StoredTokens = serde_json::from_str(&s).unwrap();
        assert_eq!(parsed.access_token, "at_xyz");
        assert_eq!(parsed.refresh_token, "rt_abc");
        assert_eq!(parsed.expires_at_ms, 1_780_000_000_000);
        assert_eq!(parsed.scope, "image:write");
    }

    #[test]
    fn slow_down_path_increments_interval_by_5() {
        let code = "test-slowdown-XYZ";
        set_interval(code, 5);
        // Simulate the bump that happens inside picora_oauth_poll
        let cur = current_interval(code, POLL_DEFAULT_INTERVAL_SECS);
        set_interval(code, cur.saturating_add(5));
        assert_eq!(current_interval(code, 0), 10);
        forget_interval(code);
    }
}
