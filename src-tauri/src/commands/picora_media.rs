/**
 * Picora media listing & detail commands.
 *
 * Covers:
 *   GET /v1/media?type=image|audio|video&cursor=&limit=&q=&isPublic=&kbId=&status=
 *   GET /v1/images/:id | /v1/audio/:id | /v1/videos/:id
 *   GET /v1/videos/:id/status
 *   PATCH /v1/images/:id | /v1/audio/:id | /v1/videos/:id  (visibility toggle)
 *
 * All HTTP calls use Bearer auth; errors are sanitized before returning.
 */

use picora_sdk::{PicoraClient, PicoraError};
use serde::{Deserialize, Serialize};
use tauri::command;

// HTTP client + error sanitization come from the `picora-sdk` crate now; the
// bespoke media response parsing (unified list + typed-endpoint fallbacks) stays.
fn client(api_base: &str, api_key: &str) -> Result<PicoraClient, String> {
    PicoraClient::new(api_base, api_key).map_err(|e| e.to_string())
}

// ── Types ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedMediaItem {
    pub id: String,
    #[serde(rename = "type")]
    pub media_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playback_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail_url: Option<String>,
    pub filename: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub size_bytes: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub is_public: bool,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bitrate: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kb_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MediaListResponse {
    pub items: Vec<UnifiedMediaItem>,
    pub next_cursor: Option<String>,
    pub total: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VideoStatus {
    pub id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playback_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerCaps {
    pub media_listing_v2: bool,
}

// ── Commands ──────────────────────────────────────────────────────────

/// List media assets from Picora. Corresponds to GET /v1/media.
#[command]
pub async fn picora_media_list(
    api_base: String,
    api_key: String,
    media_type: String,
    cursor: Option<String>,
    limit: u32,
    q: Option<String>,
    is_public: Option<bool>,
    kb_id: Option<String>,
    status_filter: Option<String>,
) -> Result<MediaListResponse, String> {
    if !["image", "audio", "video"].contains(&media_type.as_str()) {
        return Err(format!("Invalid media_type: {}", media_type));
    }
    let limit = limit.clamp(1, 50);

    let c = client(&api_base, &api_key)?;
    let mut req = c
        .get("/v1/media")
        .query(&[("type", media_type.as_str()), ("limit", &limit.to_string())]);
    if let Some(cur) = &cursor {
        req = req.query(&[("cursor", cur.as_str())]);
    }
    if let Some(q_val) = &q {
        if !q_val.is_empty() {
            req = req.query(&[("q", q_val.as_str())]);
        }
    }
    if let Some(pub_val) = is_public {
        req = req.query(&[("isPublic", if pub_val { "true" } else { "false" })]);
    }
    if let Some(kb) = &kb_id {
        req = req.query(&[("kbId", kb.as_str())]);
    }
    if let Some(st) = &status_filter {
        if !st.is_empty() {
            req = req.query(&[("status", st.as_str())]);
        }
    }

    let body: serde_json::Value = c.http().send_json(req, "media_list").await.map_err(|e| e.to_string())?;

    let data = body.get("data").unwrap_or(&body);
    // Picora `/v1/media` returns one of:
    //   1. `{ "data": [...] }`                           (legacy)
    //   2. `{ "data": { "items": [...], "nextCursor" } }` (paginated, v0.17.1+)
    //   3. `[...]`                                       (bare array)
    let items_val = data
        .get("items")
        .cloned()
        .or_else(|| data.as_array().map(|arr| serde_json::Value::Array(arr.clone())))
        .unwrap_or(serde_json::Value::Array(vec![]));
    // Surface the real serde error instead of silently swallowing it — a
    // single new/renamed field from the server otherwise wipes the entire
    // list with no diagnostic, leaving users with an empty picker.
    let items: Vec<UnifiedMediaItem> = serde_json::from_value(items_val)
        .map_err(|e| format!("Failed to parse Picora media list: {}", e))?;

    let next_cursor = data
        .get("nextCursor")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());

    let total = data
        .get("total")
        .and_then(|v| v.as_i64());

    Ok(MediaListResponse { items, next_cursor, total })
}

/// Fetch detail for a single media asset.
///
/// **Endpoint strategy** (per Picora v0.18.4 release notes):
///   1. Prefer `GET /v1/media/:id` — unified endpoint that auto-detects the
///      type from `med_media.media_type` and falls back to `img_images`. Uses
///      the same ID space as the `/v1/media?type=...` listing, so IDs always
///      resolve. Available on Picora ≥ v0.18.4.
///   2. Fall back to `GET /v1/{images|audio|videos}/:id` only if the unified
///      endpoint 404s — supports older Picora servers without v0.18.4.
#[command]
pub async fn picora_media_detail(
    api_base: String,
    api_key: String,
    media_type: String,
    id: String,
) -> Result<UnifiedMediaItem, String> {
    let path = match media_type.as_str() {
        "image" => "images",
        "audio" => "audio",
        "video" => "videos",
        _ => return Err(format!("Invalid media_type: {}", media_type)),
    };
    if id.trim().is_empty() {
        return Err("Media ID is empty".to_string());
    }

    let c = client(&api_base, &api_key)?;
    // 1) Unified endpoint first; 2) fall back to the type-specific path only on
    // a 404 (older Picora < v0.18.4).
    let unified = format!("/v1/media/{}", id.trim());
    let body: serde_json::Value = match c.http().send_json::<serde_json::Value>(c.get(&unified), "media_detail").await {
        Ok(v) => v,
        Err(PicoraError::Api { status: 404, .. }) => {
            let typed = format!("/v1/{}/{}", path, id.trim());
            c.http().send_json(c.get(&typed), "media_detail").await.map_err(|e| e.to_string())?
        }
        Err(e) => return Err(e.to_string()),
    };

    let data = body.get("data").unwrap_or(&body);
    let mut item: UnifiedMediaItem = serde_json::from_value(data.clone())
        .map_err(|_| "Failed to parse media detail response".to_string())?;

    // Defensive URL recovery: when both `url` and `playbackUrl` are empty,
    // scan the raw detail JSON for any HTTPS-shaped string (covers Picora
    // server variants that put the playable URL under a different key —
    // e.g. `streamUrl`, `videoUrl`, `mp4Url`, `hlsUrl`, or nested `sources[].src`).
    if item.url.as_deref().unwrap_or("").is_empty()
        && item.playback_url.as_deref().unwrap_or("").is_empty()
    {
        if let Some(found) = find_first_url(data) {
            item.playback_url = Some(found);
        }
    }
    Ok(item)
}

/// Recursively walk a JSON value and return the first string that looks like
/// a media-playable URL (https:// or http://, not the thumbnail). Skips known
/// non-playback fields like `thumbnailUrl`, `posterUrl` so the heuristic
/// doesn't accidentally pick the cover image as the playback source.
fn find_first_url(v: &serde_json::Value) -> Option<String> {
    const SKIP_KEYS: &[&str] = &["thumbnailUrl", "posterUrl", "coverUrl", "previewUrl"];
    match v {
        serde_json::Value::Object(map) => {
            for (k, child) in map.iter() {
                if SKIP_KEYS.contains(&k.as_str()) {
                    continue;
                }
                if let Some(found) = find_first_url(child) {
                    return Some(found);
                }
            }
            None
        }
        serde_json::Value::Array(arr) => {
            for child in arr {
                if let Some(found) = find_first_url(child) {
                    return Some(found);
                }
            }
            None
        }
        serde_json::Value::String(s) => {
            if s.starts_with("https://") || s.starts_with("http://") {
                Some(s.clone())
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Poll video transcoding status.
#[command]
pub async fn picora_video_status(
    api_base: String,
    api_key: String,
    id: String,
) -> Result<VideoStatus, String> {
    if id.trim().is_empty() {
        return Err("Video ID is empty".to_string());
    }

    let c = client(&api_base, &api_key)?;
    let url = format!("/v1/videos/{}/status", id.trim());
    let body: serde_json::Value = c.http().send_json(c.get(&url), "video_status").await.map_err(|e| e.to_string())?;

    let data = body.get("data").unwrap_or(&body);
    serde_json::from_value(data.clone())
        .map_err(|_| "Failed to parse video status response".to_string())
}

/// Toggle is_public on a media asset.
#[command]
pub async fn picora_media_update_visibility(
    api_base: String,
    api_key: String,
    media_type: String,
    id: String,
    is_public: bool,
) -> Result<(), String> {
    let path = match media_type.as_str() {
        "image" => "images",
        "audio" => "audio",
        "video" => "videos",
        _ => return Err(format!("Invalid media_type: {}", media_type)),
    };
    if id.trim().is_empty() {
        return Err("Media ID is empty".to_string());
    }

    let c = client(&api_base, &api_key)?;
    let url = format!("/v1/{}/{}", path, id.trim());
    let req = c.patch(&url).json(&serde_json::json!({ "isPublic": is_public }));
    c.http().send_text(req, "media_visibility").await.map(|_| ()).map_err(|e| e.to_string())
}

/// Probe Picora server capabilities via GET /v1/health.
#[command]
pub async fn picora_server_caps(
    api_base: String,
    api_key: String,
) -> Result<ServerCaps, String> {
    if api_base.trim().is_empty() {
        return Err("Picora endpoint is empty".to_string());
    }

    // A probe with special semantics — optional auth, and any failure yields
    // `media_listing_v2: false` rather than an error — so it uses the crate's
    // shared HTTP client directly instead of the (token-requiring) PicoraClient.
    let http = picora_sdk::http::HttpCore::new().map_err(|e| e.to_string())?;
    let url = format!("{}/v1/health", api_base.trim_end_matches('/'));
    let mut req = http.reqwest().get(&url);
    if !api_key.is_empty() {
        req = req.bearer_auth(&api_key);
    }

    let res = req.send().await.map_err(|_| "Network error contacting Picora".to_string())?;

    if !res.status().is_success() {
        return Ok(ServerCaps { media_listing_v2: false });
    }

    let body: serde_json::Value = res
        .json()
        .await
        .unwrap_or(serde_json::json!({}));

    let media_listing_v2 = body
        .pointer("/data/features/mediaListingV2")
        .or_else(|| body.pointer("/features/mediaListingV2"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    Ok(ServerCaps { media_listing_v2 })
}

// ── Unit tests ────────────────────────────────────────────────────────

// Status sanitization + credential-stripping error building are tested in the
// picora-sdk crate now; this file's remaining logic is the bespoke media
// response parsing exercised via the live commands.
