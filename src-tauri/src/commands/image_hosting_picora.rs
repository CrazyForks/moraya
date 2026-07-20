/**
 * Picora image hosting commands.
 *
 * Picora is the recommended SaaS image host for Moraya. It exposes:
 *   - POST /v1/images           multipart/form-data upload, Bearer auth
 *   - GET  /v1/user/me          current user info (for V1 deep-link verify)
 *   - POST /v1/auth/exchange-export-token   one-time token → real config (V2)
 *
 * All Picora HTTP requests go through this module so frontend CSP `connect-src`
 * stays locked. Errors are sanitized — the Bearer token / OTT never appears in
 * the message returned to the renderer.
 */

use serde::{Deserialize, Serialize};
use tauri::command;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PicoraUserInfo {
    pub email: String,
    pub plan: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nickname: Option<String>,
    // v1.22.0 (server v0.74.0): server-side doc versioning user settings.
    // Absent on older Picora deployments.
    #[serde(rename = "docVersioningEnabled", skip_serializing_if = "Option::is_none")]
    pub doc_versioning_enabled: Option<bool>,
    #[serde(rename = "docVersioningMax", skip_serializing_if = "Option::is_none")]
    pub doc_versioning_max: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PicoraImportPayload {
    #[serde(rename = "apiUrl")]
    pub api_url: String,
    #[serde(rename = "apiKey")]
    pub api_key: String,
    #[serde(rename = "imgDomain")]
    pub img_domain: String,
    pub user: PicoraUserInfo,
}

// HTTP client + error sanitization live in the `picora-sdk` crate now. Most
// commands here build a `PicoraClient`; `upload_to_picora` (multipart POST to a
// full image-endpoint URL, not base+path) and the OTT exchange use the crate's
// lower-level `HttpCore` + `build_error_with_body` directly.
use picora_sdk::error::build_error_with_body;
use picora_sdk::http::HttpCore;
use picora_sdk::PicoraClient;

fn client(api_base: &str, api_key: &str) -> Result<PicoraClient, String> {
    PicoraClient::new(api_base, api_key).map_err(|e| e.to_string())
}

/// Upload a single image to Picora. Returns the public URL of the uploaded asset.
#[command]
pub async fn upload_to_picora(
    api_url: String,
    api_key: String,
    file_bytes: Vec<u8>,
    mime_type: String,
    filename: String,
) -> Result<String, String> {
    if api_url.trim().is_empty() {
        return Err("Picora endpoint is empty".to_string());
    }
    if api_key.trim().is_empty() {
        return Err("Picora API key is empty".to_string());
    }

    // Multipart POST to a FULL image-endpoint URL (not base+path), so this uses
    // the crate's shared HTTP client directly rather than PicoraClient's path join.
    let http = HttpCore::new().map_err(|e| e.to_string())?;
    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name(filename)
        .mime_str(&mime_type)
        .map_err(|_| "Invalid image MIME type".to_string())?;
    let form = reqwest::multipart::Form::new().part("file", part);

    let res = http
        .reqwest()
        .post(&api_url)
        .bearer_auth(&api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|_| "Network error contacting Picora".to_string())?;

    if !res.status().is_success() {
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        return Err(build_error_with_body(status, &body, "upload"));
    }

    let body: serde_json::Value = res
        .json()
        .await
        .map_err(|_| "Picora returned invalid JSON".to_string())?;

    body.get("data")
        .and_then(|d| d.get("url"))
        .and_then(|u| u.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "Picora response missing image URL".to_string())
}

/// Verify a Picora API key by calling /v1/user/me. Returns lightweight user info.
#[command]
pub async fn verify_picora_token(
    api_base: String,
    api_key: String,
) -> Result<PicoraUserInfo, String> {
    let c = client(&api_base, &api_key)?;
    let body: serde_json::Value = c
        .http()
        .send_json(c.get("/v1/user/me"), "verify")
        .await
        .map_err(|e| e.to_string())?;

    let data = body
        .get("data")
        .ok_or_else(|| "Picora response missing user data".to_string())?;

    Ok(PicoraUserInfo {
        email: data
            .get("email")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        plan: data
            .get("plan")
            .and_then(|v| v.as_str())
            .unwrap_or("free")
            .to_string(),
        nickname: data
            .get("nickname")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        doc_versioning_enabled: data.get("docVersioningEnabled").and_then(|v| v.as_bool()),
        doc_versioning_max: data
            .get("docVersioningMax")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32),
    })
}

/// Lightweight connection test: GET /v1/auth/verify with Bearer token.
/// Returns Ok(()) when the token is valid; otherwise a sanitized error.
/// Used by the "Test Connection" button so we don't upload a placeholder
/// image to the user's bucket just to check credentials.
#[command]
pub async fn test_picora_connection(
    api_base: String,
    api_key: String,
) -> Result<(), String> {
    let c = client(&api_base, &api_key)?;
    c.http()
        .send_text(c.get("/v1/auth/verify"), "test")
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Exchange a one-time export token for the full Picora import payload (V2 flow).
#[command]
pub async fn exchange_picora_export_token(
    api_base: String,
    ott: String,
) -> Result<PicoraImportPayload, String> {
    if api_base.trim().is_empty() {
        return Err("Picora endpoint is empty".to_string());
    }
    if ott.trim().is_empty() {
        return Err("Picora import token is empty".to_string());
    }

    // No bearer here — the one-time token is carried in the body — so this uses
    // the crate's shared HTTP client directly (PicoraClient requires a token).
    let http = HttpCore::new().map_err(|e| e.to_string())?;
    let url = format!("{}/v1/auth/exchange-export-token", api_base.trim_end_matches('/'));
    let res = http
        .reqwest()
        .post(&url)
        .json(&serde_json::json!({ "ott": ott }))
        .send()
        .await
        .map_err(|_| "Network error contacting Picora".to_string())?;

    if !res.status().is_success() {
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        return Err(build_error_with_body(status, &body, "exchange"));
    }

    let body: serde_json::Value = res
        .json()
        .await
        .map_err(|_| "Picora returned invalid JSON".to_string())?;
    let data = body
        .get("data")
        .ok_or_else(|| "Picora response missing payload".to_string())?;

    let api_url = data
        .get("apiUrl")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Picora payload missing apiUrl".to_string())?
        .to_string();
    let api_key = data
        .get("apiKey")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Picora payload missing apiKey".to_string())?
        .to_string();
    let img_domain = data
        .get("imgDomain")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let user = data
        .get("user")
        .ok_or_else(|| "Picora payload missing user".to_string())?;

    Ok(PicoraImportPayload {
        api_url,
        api_key,
        img_domain,
        user: PicoraUserInfo {
            email: user
                .get("email")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            plan: user
                .get("plan")
                .and_then(|v| v.as_str())
                .unwrap_or("free")
                .to_string(),
            nickname: user
                .get("nickname")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            doc_versioning_enabled: None,
            doc_versioning_max: None,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Status sanitization (incl. 410-expired) is tested in the picora-sdk crate.

    #[test]
    fn upload_payload_structure_serializes() {
        let payload = PicoraImportPayload {
            api_url: "https://api.picora.me/v1/images".to_string(),
            api_key: "sk_live_test".to_string(),
            img_domain: "https://media.picora.me".to_string(),
            user: PicoraUserInfo {
                email: "test@example.com".to_string(),
                plan: "pro".to_string(),
                nickname: None,
                doc_versioning_enabled: None,
                doc_versioning_max: None,
            },
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("\"apiUrl\""));
        assert!(json.contains("\"apiKey\""));
        assert!(json.contains("\"imgDomain\""));
        assert!(!json.contains("nickname"));
    }
}
