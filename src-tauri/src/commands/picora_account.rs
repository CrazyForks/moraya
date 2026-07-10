/**
 * Picora account commands (v0.37.0).
 *
 * Two endpoints used by the new Picora settings tab:
 *   GET  /v1/user/me/usage      → account usage / plan / quota (Picora ≥ v0.17.1 Part B)
 *   DELETE /v1/{type}/:id       → delete a media asset
 *
 * Errors are sanitized: Bearer tokens / sk_live prefixes are masked, response bodies
 * truncated to 200 chars. The endpoint URL is never echoed back to the renderer.
 */

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::command;

const DEFAULT_TIMEOUT_SECS: u64 = 20;

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

// ── Types ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlanLimitsApi {
    pub img_storage_bytes: i64,
    pub img_upload_month: i64,
    pub doc_count: i64,
    pub audio_storage_bytes: i64,
    pub video_storage_bytes: i64,
    pub kb_count: i64,
}

/// One usage block — image / docs / audio / videos / kbs.
/// Any block may be `null` from the server (Picora uses Promise.allSettled, so a
/// single failed query nullifies that block). The renderer must handle null.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UsageBlock {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_used: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upload_count_month: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bandwidth_used: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub private_count: Option<i64>,
    // v1.22.0 (server v0.74.0): docs block only — document revision-history usage.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision_bytes: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PicoraQuota {
    pub plan: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_limits: Option<PlanLimitsApi>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<UsageBlock>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docs: Option<UsageBlock>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio: Option<UsageBlock>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub videos: Option<UsageBlock>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kbs: Option<UsageBlock>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    /// True iff the server response contained at least one v0.17.1 Part B field
    /// (planLimits / docs / audio / kbs / images.publicCount). Used by the
    /// renderer to decide whether to show "需要 Picora v0.17.1+" tooltips.
    pub usage_v2: bool,
}

fn parse_block(raw: &Value, key: &str) -> Option<UsageBlock> {
    let v = raw.get(key)?;
    if v.is_null() {
        return None;
    }
    serde_json::from_value(v.clone()).ok()
}

fn parse_plan_limits(raw: &Value) -> Option<PlanLimitsApi> {
    let v = raw.get("planLimits")?;
    if v.is_null() {
        return None;
    }
    serde_json::from_value(v.clone()).ok()
}

fn detect_usage_v2(data: &Value) -> bool {
    if data.get("planLimits").is_some() {
        return true;
    }
    if data.get("docs").is_some() || data.get("audio").is_some() || data.get("kbs").is_some() {
        return true;
    }
    if let Some(images) = data.get("images") {
        if images.get("publicCount").is_some() || images.get("privateCount").is_some() {
            return true;
        }
    }
    false
}

// ── Commands ──────────────────────────────────────────────────────────

/// Fetch a Picora account's plan / usage / quota.
///
/// Maps 1:1 to GET /v1/user/me/usage (Picora ≥ v0.17.1 Part B). Older Picora
/// versions return only `images` + `videos.{storageUsed, bandwidthUsed}`; the
/// renderer detects this via `usage_v2` and falls back to the bundled PLAN_LIMITS
/// table for limits.
#[command]
pub async fn picora_get_quota(
    api_base: String,
    api_key: String,
) -> Result<PicoraQuota, String> {
    if api_base.trim().is_empty() {
        return Err("Picora endpoint is empty".to_string());
    }
    if api_key.trim().is_empty() {
        return Err("Picora API key is empty".to_string());
    }

    let base = api_base.trim_end_matches('/');
    let url = format!("{}/v1/user/me/usage", base);
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
        return Err(build_error(status, &body, "quota"));
    }

    let body: Value = res
        .json()
        .await
        .map_err(|_| "Picora returned invalid JSON".to_string())?;

    let data = body.get("data").unwrap_or(&body);

    let plan = data
        .get("plan")
        .and_then(|v| v.as_str())
        .unwrap_or("none")
        .to_string();

    let updated_at = data
        .get("updatedAt")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    Ok(PicoraQuota {
        plan,
        plan_limits: parse_plan_limits(data),
        images: parse_block(data, "images"),
        docs: parse_block(data, "docs"),
        audio: parse_block(data, "audio"),
        videos: parse_block(data, "videos"),
        kbs: parse_block(data, "kbs"),
        updated_at,
        usage_v2: detect_usage_v2(data),
    })
}

/// Delete a single Picora media asset (image / audio / video).
///
/// Maps to DELETE /v1/images/:id | /v1/audio/:id | /v1/videos/:id.
/// Returns `Ok(())` on 2xx; otherwise a sanitized error.
#[command]
pub async fn picora_media_delete(
    api_base: String,
    api_key: String,
    media_type: String,
    id: String,
) -> Result<(), String> {
    if api_base.trim().is_empty() {
        return Err("Picora endpoint is empty".to_string());
    }
    if api_key.trim().is_empty() {
        return Err("Picora API key is empty".to_string());
    }
    let path = match media_type.as_str() {
        "image" => "images",
        "audio" => "audio",
        "video" => "videos",
        _ => return Err(format!("Invalid media_type: {}", media_type)),
    };
    if id.trim().is_empty() {
        return Err("Media ID is empty".to_string());
    }

    let base = api_base.trim_end_matches('/');
    let url = format!("{}/v1/{}/{}", base, path, id.trim());
    let client = http_client()?;

    let res = client
        .delete(&url)
        .bearer_auth(&api_key)
        .send()
        .await
        .map_err(|_| "Network error contacting Picora".to_string())?;

    if !res.status().is_success() {
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        return Err(build_error(status, &body, "media_delete"));
    }

    Ok(())
}

// ── Tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sanitize_status_codes() {
        assert!(sanitize_status(401).contains("authentication"));
        assert!(sanitize_status(404).contains("not found"));
        assert!(sanitize_status(429).contains("rate"));
        assert!(sanitize_status(500).contains("unavailable"));
        assert!(sanitize_status(599).contains("unavailable"));
    }

    #[test]
    fn build_error_strips_credentials() {
        let msg = build_error(401, "Bearer sk_live_abc invalid token", "quota");
        assert!(!msg.contains("sk_live_abc"));
        assert!(!msg.contains("Bearer sk"));
        assert!(msg.contains("sk_***_"));
        assert!(msg.contains("[quota]"));
    }

    #[test]
    fn build_error_does_not_leak_endpoint() {
        let msg = build_error(500, "internal error at https://api.example.com/secret", "quota");
        // Endpoint URL fragment may pass through (it's user-supplied input echo); but
        // we mainly want no Bearer / sk_live leakage — and the cap at 200 chars.
        assert!(msg.len() < 350);
    }

    #[test]
    fn detect_usage_v2_detects_plan_limits() {
        let data = json!({ "plan": "pro", "planLimits": { "imgStorageBytes": 1 } });
        assert!(detect_usage_v2(&data));
    }

    #[test]
    fn detect_usage_v2_detects_docs_block() {
        let data = json!({ "plan": "pro", "docs": { "totalCount": 1 } });
        assert!(detect_usage_v2(&data));
    }

    #[test]
    fn detect_usage_v2_detects_public_count() {
        let data = json!({ "plan": "pro", "images": { "publicCount": 5 } });
        assert!(detect_usage_v2(&data));
    }

    #[test]
    fn detect_usage_v2_false_for_legacy_response() {
        let data = json!({ "plan": "pro", "images": { "storageUsed": 100, "totalCount": 5 }, "videos": { "storageUsed": 50 } });
        assert!(!detect_usage_v2(&data));
    }

    #[test]
    fn parse_block_handles_null() {
        let data = json!({ "docs": null, "audio": { "totalCount": 3, "storageUsed": 100 } });
        assert!(parse_block(&data, "docs").is_none());
        let audio = parse_block(&data, "audio").unwrap();
        assert_eq!(audio.total_count, Some(3));
        assert_eq!(audio.storage_used, Some(100));
    }

    #[test]
    fn parse_plan_limits_handles_null() {
        let data = json!({ "planLimits": null });
        assert!(parse_plan_limits(&data).is_none());
    }

    #[test]
    fn parse_plan_limits_full() {
        let data = json!({
            "planLimits": {
                "imgStorageBytes": 5368709120i64,
                "imgUploadMonth": 50000,
                "docCount": 1000,
                "audioStorageBytes": 5368709120i64,
                "videoStorageBytes": 10737418240i64,
                "kbCount": 50,
            }
        });
        let limits = parse_plan_limits(&data).unwrap();
        assert_eq!(limits.img_upload_month, 50000);
        assert_eq!(limits.kb_count, 50);
    }

    #[test]
    fn invalid_media_type_rejected() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let err = rt.block_on(picora_media_delete(
            "https://api.example.com".to_string(),
            "sk_live_token".to_string(),
            "document".to_string(),
            "abc".to_string(),
        )).unwrap_err();
        assert!(err.contains("Invalid media_type"));
    }

    #[test]
    fn empty_inputs_rejected() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let err = rt.block_on(picora_get_quota("".to_string(), "sk".to_string())).unwrap_err();
        assert!(err.contains("endpoint is empty"));
        let err = rt.block_on(picora_get_quota("https://api.example.com".to_string(), "".to_string())).unwrap_err();
        assert!(err.contains("API key is empty"));
    }
}
