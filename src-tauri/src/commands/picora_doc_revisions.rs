/**
 * Picora document revision-history commands (server v0.74.0, client v1.22.0).
 *
 * Server-side revisions are produced automatically when KB sync replaces a
 * document's content — the client never uploads versions. These commands are
 * the read/settings/cleanup surface:
 *
 *  - picora_doc_revisions          GET    /v1/docs/{id}/revisions          (plan-gate-free read)
 *  - picora_doc_revision_content   GET    /v1/docs/{id}/revisions/{revId}  (plan-gate-free read)
 *  - picora_clear_doc_revisions    DELETE /v1/user/me/doc-revisions        (plan-gate-free, batched)
 *  - picora_update_user_settings   PATCH  /v1/user/me                      (docVersioning* fields)
 *
 * All HTTP goes through reqwest here so the frontend CSP `connect-src` stays
 * IPC-only. Credentials arrive as (apiBase, apiKey) resolved by the frontend
 * from Keychain/OAuth (same pattern as kb_sync.rs). Errors are sanitized.
 */

use serde::{Deserialize, Serialize};
use tauri::command;

const DEFAULT_TIMEOUT_SECS: u64 = 30;
// DELETE /v1/user/me/doc-revisions processes ≤200 rows per call and signals
// `hasMore`. 50 rounds ≈ 10,000 revisions — far above any real account.
const MAX_CLEAR_ROUNDS: u32 = 50;

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(DEFAULT_TIMEOUT_SECS))
        .build()
        .map_err(|_| "Failed to initialize HTTP client".to_string())
}

fn sanitize_status(status: u16) -> String {
    match status {
        401 | 403 => format!("Picora authentication failed ({})", status),
        404 => "Picora resource not found (404)".to_string(),
        408 | 504 => format!("Picora request timed out ({})", status),
        422 => "Picora rejected the request (422)".to_string(),
        429 => "Picora rate limit exceeded (429)".to_string(),
        500..=599 => format!("Picora service unavailable ({})", status),
        _ => format!("Picora request failed ({})", status),
    }
}

fn build_error(status: u16, body: &str, ctx: &str) -> String {
    let cleaned: String = body
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(200)
        .collect();
    let cleaned = cleaned
        .replace("sk_live_", "sk_***_")
        .replace("Bearer ", "Bearer ***");
    if cleaned.is_empty() {
        format!("[{}] {}", ctx, sanitize_status(status))
    } else {
        format!("[{}] {} — {}", ctx, sanitize_status(status), cleaned)
    }
}

fn validate_creds(api_base: &str, api_key: &str) -> Result<(), String> {
    if api_base.trim().is_empty() {
        return Err("Picora endpoint is empty".to_string());
    }
    if api_key.trim().is_empty() {
        return Err("Picora API key is empty".to_string());
    }
    Ok(())
}

/// Server ids are nanoid(21): alphanumeric plus `-` and `_`. Reject anything
/// else before it reaches a URL path segment.
fn validate_nanoid(id: &str, label: &str) -> Result<(), String> {
    if id.len() != 21
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("Invalid {} format", label));
    }
    Ok(())
}

// ── Types ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRevision {
    pub id: String,
    pub rev_number: i64,
    pub size_bytes: i64,
    /// 'upload' | 'sync' | 'restore' (server-side origin enum)
    pub origin: String,
    pub source_hash: String,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRevisionList {
    pub revisions: Vec<RemoteRevision>,
    pub total_bytes: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRevisionContent {
    pub content: String,
    pub rev_number: i64,
    pub source_hash: String,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClearRevisionsResult {
    pub deleted: i64,
    pub freed_bytes: i64,
}

// ── Commands ──────────────────────────────────────────────────────────

/// List a document's server-side revision history (revNumber descending,
/// already pruned to the account's docVersioningMax by the server).
#[command]
pub async fn picora_doc_revisions(
    api_base: String,
    api_key: String,
    doc_id: String,
) -> Result<RemoteRevisionList, String> {
    validate_creds(&api_base, &api_key)?;
    validate_nanoid(doc_id.trim(), "document id")?;

    let url = format!(
        "{}/v1/docs/{}/revisions",
        api_base.trim_end_matches('/'),
        doc_id.trim()
    );
    let client = http_client()?;
    let res = client
        .get(&url)
        .bearer_auth(&api_key)
        .send()
        .await
        .map_err(|_| "Network error contacting Picora".to_string())?;

    if !res.status().is_success() {
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        return Err(build_error(status, &body, "doc_revisions"));
    }

    let body: serde_json::Value = res
        .json()
        .await
        .map_err(|_| "Picora returned invalid JSON".to_string())?;
    let data = body.get("data").unwrap_or(&body);
    serde_json::from_value(data.clone())
        .map_err(|_| "Failed to parse revisions response".to_string())
}

/// Fetch one revision's full markdown content plus metadata.
#[command]
pub async fn picora_doc_revision_content(
    api_base: String,
    api_key: String,
    doc_id: String,
    rev_id: String,
) -> Result<RemoteRevisionContent, String> {
    validate_creds(&api_base, &api_key)?;
    validate_nanoid(doc_id.trim(), "document id")?;
    validate_nanoid(rev_id.trim(), "revision id")?;

    let url = format!(
        "{}/v1/docs/{}/revisions/{}",
        api_base.trim_end_matches('/'),
        doc_id.trim(),
        rev_id.trim()
    );
    let client = http_client()?;
    let res = client
        .get(&url)
        .bearer_auth(&api_key)
        .send()
        .await
        .map_err(|_| "Network error contacting Picora".to_string())?;

    if !res.status().is_success() {
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        return Err(build_error(status, &body, "doc_revision_content"));
    }

    let body: serde_json::Value = res
        .json()
        .await
        .map_err(|_| "Picora returned invalid JSON".to_string())?;
    let data = body.get("data").unwrap_or(&body);
    serde_json::from_value(data.clone())
        .map_err(|_| "Failed to parse revision content response".to_string())
}

/// Clear ALL of the account's document revisions. The server processes at
/// most 200 rows per call and signals `hasMore` — loop until done (bounded).
#[command]
pub async fn picora_clear_doc_revisions(
    api_base: String,
    api_key: String,
) -> Result<ClearRevisionsResult, String> {
    validate_creds(&api_base, &api_key)?;

    let url = format!(
        "{}/v1/user/me/doc-revisions",
        api_base.trim_end_matches('/')
    );
    let client = http_client()?;

    let mut total_deleted: i64 = 0;
    let mut total_freed: i64 = 0;
    for _ in 0..MAX_CLEAR_ROUNDS {
        let res = client
            .delete(&url)
            .bearer_auth(&api_key)
            .send()
            .await
            .map_err(|_| "Network error contacting Picora".to_string())?;

        if !res.status().is_success() {
            let status = res.status().as_u16();
            let body = res.text().await.unwrap_or_default();
            return Err(build_error(status, &body, "clear_revisions"));
        }

        let body: serde_json::Value = res
            .json()
            .await
            .map_err(|_| "Picora returned invalid JSON".to_string())?;
        let data = body.get("data").unwrap_or(&body);
        total_deleted += data.get("deleted").and_then(|v| v.as_i64()).unwrap_or(0);
        total_freed += data.get("freedBytes").and_then(|v| v.as_i64()).unwrap_or(0);
        let has_more = data
            .get("hasMore")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if !has_more {
            break;
        }
    }

    Ok(ClearRevisionsResult {
        deleted: total_deleted,
        freed_bytes: total_freed,
    })
}

/// Update the account's server-side doc-versioning settings
/// (PATCH /v1/user/me — whitelisted, any plan may change them).
#[command]
pub async fn picora_update_user_settings(
    api_base: String,
    api_key: String,
    doc_versioning_enabled: Option<bool>,
    doc_versioning_max: Option<u32>,
) -> Result<(), String> {
    validate_creds(&api_base, &api_key)?;
    if doc_versioning_enabled.is_none() && doc_versioning_max.is_none() {
        return Err("No settings to update".to_string());
    }
    if let Some(max) = doc_versioning_max {
        if !(1..=500).contains(&max) {
            return Err("docVersioningMax must be between 1 and 500".to_string());
        }
    }

    let url = format!("{}/v1/user/me", api_base.trim_end_matches('/'));
    let client = http_client()?;

    let mut body = serde_json::Map::new();
    if let Some(enabled) = doc_versioning_enabled {
        body.insert("docVersioningEnabled".to_string(), enabled.into());
    }
    if let Some(max) = doc_versioning_max {
        body.insert("docVersioningMax".to_string(), max.into());
    }

    let res = client
        .patch(&url)
        .bearer_auth(&api_key)
        .json(&serde_json::Value::Object(body))
        .send()
        .await
        .map_err(|_| "Network error contacting Picora".to_string())?;

    if !res.status().is_success() {
        let status = res.status().as_u16();
        let body_text = res.text().await.unwrap_or_default();
        return Err(build_error(status, &body_text, "user_settings"));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_nanoid_accepts_valid_ids() {
        assert!(validate_nanoid("V1StGXR8_Z5jdHi6B-myT", "document id").is_ok());
    }

    #[test]
    fn validate_nanoid_rejects_wrong_length() {
        assert!(validate_nanoid("short", "document id").is_err());
        assert!(validate_nanoid("", "document id").is_err());
    }

    #[test]
    fn validate_nanoid_rejects_path_traversal() {
        assert!(validate_nanoid("../../../v1/user/me/x", "document id").is_err());
        assert!(validate_nanoid("a/b/c/d/e/f/g/h/i/j/k", "document id").is_err());
    }

    #[test]
    fn build_error_strips_bearer_token() {
        let msg = build_error(401, "Bearer sk_live_secret123", "test");
        assert!(!msg.contains("sk_live_secret123"));
        assert!(msg.contains("sk_***_"));
    }

    #[test]
    fn build_error_truncates_long_body() {
        let long = "x".repeat(600);
        let msg = build_error(500, &long, "test");
        assert!(msg.len() < 300);
    }

    #[test]
    fn revision_list_parses_server_shape() {
        let json = serde_json::json!({
            "revisions": [{
                "id": "Rk9MR2PQ7vB01234567ab",
                "revNumber": 3,
                "sizeBytes": 20480,
                "origin": "sync",
                "sourceHash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                "createdAt": "2026-07-10T08:00:00.000Z"
            }],
            "totalBytes": 61440
        });
        let parsed: RemoteRevisionList = serde_json::from_value(json).unwrap();
        assert_eq!(parsed.revisions.len(), 1);
        assert_eq!(parsed.revisions[0].rev_number, 3);
        assert_eq!(parsed.revisions[0].origin, "sync");
        assert_eq!(parsed.total_bytes, 61440);
    }
}
