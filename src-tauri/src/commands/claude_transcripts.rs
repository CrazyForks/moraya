//! Read-only access to Claude Code session transcripts for the prompt-asset
//! capture feature (docs/specs/prompt-asset.md).
//!
//! Transcripts live at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
//! `read_dir_recursive` (file.rs) deliberately skips dot-directories, so it
//! cannot enumerate `.claude`; these two commands provide a narrow, read-only
//! window scoped strictly to `<home>/.claude/**`. No write/delete surface.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// Cap per-transcript read to avoid pathological memory use on a giant file.
const MAX_TRANSCRIPT_BYTES: u64 = 32 * 1024 * 1024;
/// Cap the number of transcript files returned by a single scan.
const MAX_TRANSCRIPTS: usize = 5000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptFileInfo {
    /// Absolute path to the `.jsonl` transcript.
    pub path: String,
    /// Encoded project directory name (e.g. "-Users-me-Documents-app").
    pub dir_name: String,
    /// Session id = transcript file stem.
    pub session_id: String,
    /// Modification time, seconds since the UNIX epoch.
    pub mtime: f64,
}

/// Resolve the Claude Code root directory, restricted to within the user's
/// home. A custom directory is accepted only if it canonicalizes to a location
/// inside the home directory (defense against traversal / arbitrary reads).
fn claude_root(custom: Option<String>) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
    let root = match custom {
        Some(c) if !c.trim().is_empty() => PathBuf::from(c),
        _ => home.join(".claude"),
    };
    // Canonicalize when it exists so `..` / symlinks can't escape home.
    let resolved = fs::canonicalize(&root).unwrap_or(root);
    if !resolved.starts_with(&home) {
        return Err("Access denied: path outside allowed directory".to_string());
    }
    Ok(resolved)
}

/// Pure guard: a canonical path is an allowed transcript iff it lives within
/// the Claude root and ends in `.jsonl`. Split out so it is unit-testable
/// without touching the real filesystem.
fn is_allowed_transcript(canonical: &Path, claude_root: &Path) -> Result<(), String> {
    if !canonical.starts_with(claude_root) {
        return Err("Access denied: path outside allowed directory".to_string());
    }
    if canonical.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return Err("Access denied: not a transcript".to_string());
    }
    Ok(())
}

/// Ensure `path` resolves to a `.jsonl` file within `<home>/.claude/**`.
fn validate_transcript_path(path: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
    let claude = home.join(".claude");
    let canonical = fs::canonicalize(path).map_err(|_| "File not found".to_string())?;
    is_allowed_transcript(&canonical, &claude)?;
    Ok(canonical)
}

/// Enumerate all Claude Code session transcripts under `<root>/projects`.
/// Returns file metadata only (no contents). Skips symlinks and non-`.jsonl`.
#[tauri::command]
pub async fn list_claude_transcripts(
    claude_dir: Option<String>,
) -> Result<Vec<TranscriptFileInfo>, String> {
    let root = claude_root(claude_dir)?;
    let projects = root.join("projects");
    if !projects.is_dir() {
        return Ok(Vec::new());
    }

    tokio::task::spawn_blocking(move || scan_projects(&projects))
        .await
        .map_err(|_| "Operation failed".to_string())?
}

fn scan_projects(projects: &Path) -> Result<Vec<TranscriptFileInfo>, String> {
    let mut out: Vec<TranscriptFileInfo> = Vec::new();
    let project_dirs = fs::read_dir(projects).map_err(|_| "Operation failed".to_string())?;

    for project in project_dirs {
        let project = match project {
            Ok(p) => p,
            Err(_) => continue,
        };
        let project_path = project.path();
        // Skip symlinked project dirs (could point outside .claude).
        if project_path
            .symlink_metadata()
            .map(|m| m.is_symlink())
            .unwrap_or(false)
            || !project_path.is_dir()
        {
            continue;
        }
        let dir_name = project.file_name().to_string_lossy().to_string();

        let files = match fs::read_dir(&project_path) {
            Ok(f) => f,
            Err(_) => continue,
        };
        for file in files {
            let file = match file {
                Ok(f) => f,
                Err(_) => continue,
            };
            let file_path = file.path();
            if file_path
                .symlink_metadata()
                .map(|m| m.is_symlink())
                .unwrap_or(false)
            {
                continue;
            }
            if file_path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let session_id = file_path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let mtime = file_path
                .metadata()
                .and_then(|m| m.modified())
                .map(|t| {
                    t.duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs_f64()
                })
                .unwrap_or(0.0);

            out.push(TranscriptFileInfo {
                path: file_path.to_string_lossy().to_string(),
                dir_name: dir_name.clone(),
                session_id,
                mtime,
            });
            if out.len() >= MAX_TRANSCRIPTS {
                return Ok(out);
            }
        }
    }
    Ok(out)
}

/// Read one transcript's raw JSONL text. Rejects paths outside `<home>/.claude`
/// and files larger than the size cap.
#[tauri::command]
pub async fn read_claude_transcript(path: String) -> Result<String, String> {
    let safe = validate_transcript_path(&path)?;
    tokio::task::spawn_blocking(move || {
        let meta = fs::metadata(&safe).map_err(|_| "File not found".to_string())?;
        if meta.len() > MAX_TRANSCRIPT_BYTES {
            return Err("File too large".to_string());
        }
        fs::read_to_string(&safe).map_err(|_| "Operation failed".to_string())
    })
    .await
    .map_err(|_| "Operation failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_jsonl_within_claude_root() {
        let root = PathBuf::from("/home/me/.claude");
        let path = PathBuf::from("/home/me/.claude/projects/proj/sess.jsonl");
        assert!(is_allowed_transcript(&path, &root).is_ok());
    }

    #[test]
    fn rejects_path_outside_claude_root() {
        let root = PathBuf::from("/home/me/.claude");
        let path = PathBuf::from("/home/me/.ssh/id_rsa.jsonl");
        assert!(is_allowed_transcript(&path, &root).is_err());
    }

    #[test]
    fn rejects_non_jsonl_extension() {
        let root = PathBuf::from("/home/me/.claude");
        let path = PathBuf::from("/home/me/.claude/projects/proj/secrets.json");
        assert!(is_allowed_transcript(&path, &root).is_err());
    }

    #[test]
    fn rejects_traversal_style_prefix_escape() {
        // A sibling dir that merely shares a name prefix must not be accepted.
        let root = PathBuf::from("/home/me/.claude");
        let path = PathBuf::from("/home/me/.claude-evil/x.jsonl");
        assert!(is_allowed_transcript(&path, &root).is_err());
    }
}
