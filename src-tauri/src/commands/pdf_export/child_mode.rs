//! Subprocess child-mode helpers.
//!
//! These are scaffolding for the subprocess child-mode startup path that
//! lib.rs wires up at app launch on Windows/Linux. The macOS direct path
//! never invokes them, hence the dead-code allow.

#![allow(dead_code)]
//!
//! When Moraya is launched with `--print-pdf-config=<path>` the main process
//! detects the flag early and enters a minimal headless mode that loads the
//! /print route, drives WKWebView/WebView2/WebKitGTK printToPDF, writes the
//! PDF to the path specified in the config, and exits.
//!
//! This module exposes the argv detection and config loading; the actual
//! headless run loop lives in lib.rs (so it can reuse the same Tauri
//! infrastructure as the main path).

use super::JobConfig;

const ARG_PREFIX: &str = "--print-pdf-config=";

/// Detect `--print-pdf-config=<path>` in argv. Returns the path if present.
pub fn detect_child_mode<I, S>(args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    for a in args {
        let s = a.as_ref();
        if let Some(rest) = s.strip_prefix(ARG_PREFIX) {
            return Some(rest.to_string());
        }
    }
    None
}

/// Load the job config from a path written by the parent process.
pub fn load_config(path: &str) -> Result<JobConfig, String> {
    let bytes =
        std::fs::read(path).map_err(|e| format!("read config {path}: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse config {path}: {e}"))
}

/// Emit a progress event line on stdout (ndjson). The parent process parses
/// each line as a `ProgressEvent`.
pub fn emit_progress(ev: &super::ProgressEvent) {
    if let Ok(s) = serde_json::to_string(ev) {
        println!("{s}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_simple() {
        let args = vec!["moraya".to_string(), "--print-pdf-config=/tmp/x.json".to_string()];
        assert_eq!(detect_child_mode(&args), Some("/tmp/x.json".to_string()));
    }

    #[test]
    fn detect_absent() {
        let args = vec!["moraya".to_string(), "--other-flag".to_string()];
        assert_eq!(detect_child_mode(&args), None);
    }

    #[test]
    fn detect_among_many() {
        let args = vec![
            "moraya".to_string(),
            "--verbose".to_string(),
            "--print-pdf-config=cfg.json".to_string(),
            "--debug".to_string(),
        ];
        assert_eq!(detect_child_mode(&args), Some("cfg.json".to_string()));
    }

    #[test]
    fn load_config_roundtrip_via_tempfile() {
        // Exercises the parent → child contract: subprocess.rs serializes
        // JobConfig to a tempfile; child_mode::load_config reads it back.
        // A schema mismatch between the two sides would surface here.
        use super::super::{
            JobConfig, Margins, Orientation, PaperSize, PdfExportOptions,
        };
        let original = JobConfig {
            job_id: "roundtrip-test".to_string(),
            markdown: "# Hello\n\n中文 + emoji 🎉".to_string(),
            output_path: "/tmp/roundtrip.pdf".to_string(),
            options: PdfExportOptions {
                paper_size: PaperSize::Letter,
                orientation: Orientation::Landscape,
                margins: Margins { top: 25.0, right: 18.0, bottom: 25.0, left: 18.0 },
                header_enabled: true,
                header_template: "{title} — {date}".to_string(),
                footer_enabled: true,
                footer_template: "{page} of {total}".to_string(),
                font_size: 12.0,
                font_family: "Inter".to_string(),
                enable_highlight: true,
                enable_mermaid: false,
                enable_math: true,
                document_title: "Hello".to_string(),
            },
        };

        let path = std::env::temp_dir().join("moraya-roundtrip-test.json");
        let bytes = serde_json::to_vec(&original).unwrap();
        std::fs::write(&path, &bytes).unwrap();

        let loaded = load_config(path.to_str().unwrap()).expect("load_config should succeed");
        let _ = std::fs::remove_file(&path);

        assert_eq!(loaded.job_id, original.job_id);
        assert_eq!(loaded.markdown, original.markdown);
        assert_eq!(loaded.output_path, original.output_path);
        assert_eq!(loaded.options.paper_size, PaperSize::Letter);
        assert_eq!(loaded.options.orientation, Orientation::Landscape);
        assert_eq!(loaded.options.margins.top, 25.0);
        assert_eq!(loaded.options.header_template, "{title} — {date}");
        assert!(loaded.options.header_enabled);
        assert!(!loaded.options.enable_mermaid);
    }

    #[test]
    fn load_config_rejects_missing_file() {
        let err = load_config("/tmp/does-not-exist-xyzzy.json").unwrap_err();
        assert!(err.contains("read config"), "got: {err}");
    }

    #[test]
    fn load_config_rejects_malformed_json() {
        let path = std::env::temp_dir().join("moraya-malformed-test.json");
        std::fs::write(&path, b"{this is not json").unwrap();
        let err = load_config(path.to_str().unwrap()).unwrap_err();
        let _ = std::fs::remove_file(&path);
        assert!(err.contains("parse config"), "got: {err}");
    }
}
