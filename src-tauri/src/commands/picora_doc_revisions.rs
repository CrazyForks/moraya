/**
 * Picora document revision-history commands (server v0.74.0, client v1.22.0).
 *
 * Thin wrappers over the shared `picora-sdk` crate: the HTTP client, error
 * sanitization, and id/path validation that used to be copy-pasted here (and
 * across the other picora_* command files) now live in the crate. Credentials
 * arrive as (apiBase, apiKey) resolved by the frontend from Keychain/OAuth, so
 * the CSP `connect-src` stays IPC-only. The crate's result types serialize
 * identically to the previous local structs, so the frontend is unchanged.
 *
 *  - picora_doc_revisions          GET    /v1/docs/{id}/revisions
 *  - picora_doc_revision_content   GET    /v1/docs/{id}/revisions/{revId}
 *  - picora_clear_doc_revisions    DELETE /v1/user/me/doc-revisions   (batched)
 *  - picora_update_user_settings   PATCH  /v1/user/me                 (docVersioning*)
 */

use picora_sdk::{ClearRevisionsResult, PicoraClient, RevisionContent, RevisionList};
use tauri::command;

fn client(api_base: &str, api_key: &str) -> Result<PicoraClient, String> {
    PicoraClient::new(api_base, api_key).map_err(|e| e.to_string())
}

/// List a document's server-side revision history (revNumber descending,
/// already pruned to the account's docVersioningMax by the server).
#[command]
pub async fn picora_doc_revisions(
    api_base: String,
    api_key: String,
    doc_id: String,
) -> Result<RevisionList, String> {
    client(&api_base, &api_key)?
        .doc_revisions(doc_id.trim())
        .await
        .map_err(|e| e.to_string())
}

/// Fetch one revision's full markdown content plus metadata.
#[command]
pub async fn picora_doc_revision_content(
    api_base: String,
    api_key: String,
    doc_id: String,
    rev_id: String,
) -> Result<RevisionContent, String> {
    client(&api_base, &api_key)?
        .doc_revision_content(doc_id.trim(), rev_id.trim())
        .await
        .map_err(|e| e.to_string())
}

/// Clear ALL of the account's document revisions (batched, `hasMore`-looped).
#[command]
pub async fn picora_clear_doc_revisions(
    api_base: String,
    api_key: String,
) -> Result<ClearRevisionsResult, String> {
    client(&api_base, &api_key)?
        .clear_doc_revisions()
        .await
        .map_err(|e| e.to_string())
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
    client(&api_base, &api_key)?
        .update_doc_versioning(doc_versioning_enabled, doc_versioning_max)
        .await
        .map_err(|e| e.to_string())
}
