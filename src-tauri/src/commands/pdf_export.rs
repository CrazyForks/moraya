//! Native PDF export — print-to-PDF using each platform's WebView engine.
//!
//! Architecture: see `docs/iterations/v0.60.0-native-pdf-export.md`.
//!
//! - macOS: direct WKWebView `createPDF` via `WebviewWindow::with_webview` + objc2
//! - Windows / Linux: subprocess pattern (spawns a child Moraya process with
//!   `--print-pdf-config=<tmp.json>` which runs a hidden window and writes
//!   the PDF to disk before exiting)
//!
//! The frontend orchestrator falls back to the v0.59.x canvas-based path when
//! this command returns Err, so any failure here is recoverable.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::commands::file as file_cmd;

#[cfg(target_os = "macos")]
mod macos;

#[cfg(any(target_os = "windows", target_os = "linux"))]
mod subprocess;

pub mod child_mode;

/// Per-job ready signal. Frontend's /print route calls `export_print_ready`
/// after rendering completes; that handler resolves the matching oneshot so
/// the native printToPDF call can proceed.
pub struct PdfExportState {
    /// JobId -> ready signal sender.
    pub ready_senders: Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>,
}

impl PdfExportState {
    pub fn new() -> Self {
        Self {
            ready_senders: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for PdfExportState {
    fn default() -> Self {
        Self::new()
    }
}

/// Page-size preset (mapped to mm in `paper_size_mm`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PaperSize {
    A4,
    Letter,
    Legal,
    A3,
    A5,
}

impl PaperSize {
    /// Returns (width_mm, height_mm) for portrait orientation.
    ///
    /// Used by the /print SvelteKit route via the serialized job payload
    /// (frontend re-derives the same dimensions). Kept here as the
    /// authoritative source for documentation + future header/footer layout.
    pub fn dimensions_mm(&self) -> (f64, f64) {
        match self {
            PaperSize::A4 => (210.0, 297.0),
            PaperSize::Letter => (215.9, 279.4),
            PaperSize::Legal => (215.9, 355.6),
            PaperSize::A3 => (297.0, 420.0),
            PaperSize::A5 => (148.0, 210.0),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Orientation {
    Portrait,
    Landscape,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Margins {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

impl Default for Margins {
    fn default() -> Self {
        Margins {
            top: 20.0,
            right: 15.0,
            bottom: 20.0,
            left: 15.0,
        }
    }
}

/// Configuration sent from the frontend per export job.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfExportOptions {
    pub paper_size: PaperSize,
    pub orientation: Orientation,
    pub margins: Margins,
    #[serde(default)]
    pub header_enabled: bool,
    #[serde(default)]
    pub header_template: String,
    #[serde(default)]
    pub footer_enabled: bool,
    #[serde(default)]
    pub footer_template: String,
    #[serde(default = "default_font_size")]
    pub font_size: f64,
    #[serde(default)]
    pub font_family: String,
    #[serde(default = "default_true")]
    pub enable_highlight: bool,
    #[serde(default = "default_true")]
    pub enable_mermaid: bool,
    #[serde(default = "default_true")]
    pub enable_math: bool,
    #[serde(default)]
    pub document_title: String,
}

fn default_font_size() -> f64 {
    11.0
}
fn default_true() -> bool {
    true
}

// ---------------------------------------------------------------------------
// Shared unit conversions (used by macOS direct path + Win/Linux child mode)
// ---------------------------------------------------------------------------
//
// `POINTS_PER_INCH`, `mm_to_inches`, and `mm_to_points` are consumed by the
// cfg-gated Win/Linux child-mode implementations (v0.60.1 Phase 2/3). They
// carry `#[allow(dead_code)]` so the macOS build stays warning-free until
// those bindings land. Unit tests below exercise them on every platform.

/// 1 inch = 25.4 mm.
pub const MM_PER_INCH: f64 = 25.4;

/// CSS spec: 1 inch = 96 CSS pixels.
pub const CSS_PX_PER_INCH: f64 = 96.0;

/// PostScript / PDF / GTK PageSetup spec: 1 inch = 72 points.
#[allow(dead_code)]
pub const POINTS_PER_INCH: f64 = 72.0;

/// mm → inches (used by WebView2 `ICoreWebView2PrintSettings`, which takes
/// dimensions in floating-point inches).
#[allow(dead_code)]
#[inline]
pub fn mm_to_inches(mm: f64) -> f64 {
    mm / MM_PER_INCH
}

/// mm → PostScript points (used by GTK / WebKitGTK `PageSetup` / `PaperSize`,
/// which work in 1/72 inch units).
#[allow(dead_code)]
#[inline]
pub fn mm_to_points(mm: f64) -> f64 {
    mm / MM_PER_INCH * POINTS_PER_INCH
}

/// Compute the CSS-pixel width of the printable content area for a print job.
///
/// Shared by:
/// - macOS direct path (sets the hidden WKWebView frame width before `createPDF`)
/// - Windows / Linux subprocess child (sets the WebView2 / WebKitGTK viewport
///   width so line-break behaviour matches the printed output)
///
/// Floor of 50 mm protects against pathological margin configs that would
/// otherwise leave a negative or near-zero content area.
pub fn paper_content_viewport_width(job: &JobConfig) -> f64 {
    let (pw_mm, ph_mm) = job.options.paper_size.dimensions_mm();
    let paper_w_mm = if job.options.orientation == Orientation::Landscape {
        ph_mm
    } else {
        pw_mm
    };
    let margin_w = job.options.margins.left + job.options.margins.right;
    let content_mm = (paper_w_mm - margin_w).max(50.0);
    (content_mm / MM_PER_INCH * CSS_PX_PER_INCH).round()
}

/// Full paper width in CSS pixels (no margin subtraction).
///
/// Used by the macOS `createPDF` path: WKWebView's `createPDF` sizes the PDF
/// page to the WKWebView FRAME and ignores CSS `@page` size/margins. To produce
/// a page with real A4 margins we make the frame the FULL paper width and inset
/// the content with CSS padding (= the configured margins) instead.
pub fn paper_full_viewport_width(job: &JobConfig) -> f64 {
    let (pw_mm, ph_mm) = job.options.paper_size.dimensions_mm();
    let paper_w_mm = if job.options.orientation == Orientation::Landscape {
        ph_mm
    } else {
        pw_mm
    };
    (paper_w_mm / MM_PER_INCH * CSS_PX_PER_INCH).round()
}

impl Default for PdfExportOptions {
    fn default() -> Self {
        PdfExportOptions {
            paper_size: PaperSize::A4,
            orientation: Orientation::Portrait,
            margins: Margins::default(),
            header_enabled: false,
            header_template: String::new(),
            footer_enabled: true,
            footer_template: String::from("{page} / {total}"),
            font_size: 11.0,
            font_family: String::new(),
            enable_highlight: true,
            enable_mermaid: true,
            enable_math: true,
            document_title: String::new(),
        }
    }
}

/// Full job descriptor — what the subprocess / hidden window needs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobConfig {
    pub job_id: String,
    pub markdown: String,
    pub output_path: String,
    pub options: PdfExportOptions,
}

/// Progress events streamed back to the frontend via Channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ProgressEvent {
    Preparing,
    Rendering,
    Paginating { current: u32, total: u32 },
    Writing,
    Done,
    /// Surfaced when this code path is about to give up and let the frontend
    /// retry with the canvas-based path.
    Fallback { reason: String },
    Error { message: String },
}

/// Top-level export command. Dispatches to macOS direct path or subprocess
/// path based on target_os. Returns Err if native path fails — caller handles
/// fallback to canvas path on the frontend.
#[tauri::command]
pub async fn export_pdf_native(
    app: AppHandle,
    state: State<'_, PdfExportState>,
    job: JobConfig,
    on_progress: Channel<ProgressEvent>,
) -> Result<(), String> {
    // Validate output path safety up-front (rejects path traversal, symlinks
    // pointing outside the home dir, etc.).
    let _ = file_cmd::validate_path(&job.output_path)?;

    let _ = on_progress.send(ProgressEvent::Preparing);

    #[cfg(target_os = "macos")]
    {
        let _ = state; // unused on macOS path
        return macos::run(app, &job, &on_progress)
            .await
            .map_err(|e| {
                let _ = on_progress.send(ProgressEvent::Fallback {
                    reason: e.clone(),
                });
                e
            });
    }

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        let _ = (app, state);
        return subprocess::run(&job, &on_progress).await.map_err(|e| {
            let _ = on_progress.send(ProgressEvent::Fallback {
                reason: e.clone(),
            });
            e
        });
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = (app, state, job);
        let _ = on_progress.send(ProgressEvent::Fallback {
            reason: "unsupported platform".to_string(),
        });
        Err("Native PDF export not supported on this platform".to_string())
    }
}

/// Called by the /print SvelteKit route once rendering (Mermaid/hljs/images)
/// has completed. The matching `oneshot` is resolved so the native printToPDF
/// path can proceed.
#[tauri::command]
pub fn export_print_ready(
    state: State<'_, PdfExportState>,
    job_id: String,
) -> Result<(), String> {
    let mut senders = state
        .ready_senders
        .lock()
        .map_err(|e| format!("ready lock poisoned: {e}"))?;
    if let Some(tx) = senders.remove(&job_id) {
        let _ = tx.send(());
        Ok(())
    } else {
        Err(format!("no ready waiter for job {job_id}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paper_size_dimensions() {
        assert_eq!(PaperSize::A4.dimensions_mm(), (210.0, 297.0));
        assert_eq!(PaperSize::Letter.dimensions_mm(), (215.9, 279.4));
        assert_eq!(PaperSize::A5.dimensions_mm(), (148.0, 210.0));
    }

    #[test]
    fn margins_default() {
        let m = Margins::default();
        assert_eq!(m.top, 20.0);
        assert_eq!(m.left, 15.0);
    }

    #[test]
    fn options_default_safe_values() {
        let o = PdfExportOptions::default();
        assert_eq!(o.font_size, 11.0);
        assert!(o.enable_highlight);
        assert!(o.enable_mermaid);
        assert!(o.enable_math);
        assert!(o.footer_enabled);
        assert!(!o.header_enabled);
    }

    #[test]
    fn job_config_serde_roundtrip() {
        let job = JobConfig {
            job_id: "abc-123".to_string(),
            markdown: "# Hello".to_string(),
            output_path: "/tmp/test.pdf".to_string(),
            options: PdfExportOptions::default(),
        };
        let s = serde_json::to_string(&job).unwrap();
        let parsed: JobConfig = serde_json::from_str(&s).unwrap();
        assert_eq!(parsed.job_id, "abc-123");
        assert_eq!(parsed.options.paper_size, PaperSize::A4);
    }

    #[test]
    fn progress_event_serde_tag() {
        let ev = ProgressEvent::Paginating {
            current: 12,
            total: 200,
        };
        let s = serde_json::to_string(&ev).unwrap();
        assert!(s.contains("\"type\":\"Paginating\""));
        assert!(s.contains("\"current\":12"));
    }

    #[test]
    fn mm_to_inches_a4_short_edge() {
        // 210 mm (A4 width) = 8.2677… inch; tolerance well under WebView2's
        // ICoreWebView2PrintSettings rounding (0.01 inch).
        let v = mm_to_inches(210.0);
        assert!((v - 8.2677).abs() < 0.001, "got {v}");
    }

    #[test]
    fn mm_to_points_us_letter_long_edge() {
        // 279.4 mm (US Letter height) = 11 inch = 792 points exactly.
        let v = mm_to_points(279.4);
        assert!((v - 792.0).abs() < 0.01, "got {v}");
    }

    #[test]
    fn mm_to_inches_zero_and_negative_pass_through() {
        // Conversion is a pure linear map; safety floors live in
        // paper_content_viewport_width, not in the unit conversions.
        assert_eq!(mm_to_inches(0.0), 0.0);
        assert!(mm_to_inches(-1.0) < 0.0);
    }

    fn job_with(paper: PaperSize, orient: Orientation, margins: Margins) -> JobConfig {
        JobConfig {
            job_id: "t".to_string(),
            markdown: String::new(),
            output_path: "/tmp/x.pdf".to_string(),
            options: PdfExportOptions {
                paper_size: paper,
                orientation: orient,
                margins,
                ..PdfExportOptions::default()
            },
        }
    }

    #[test]
    fn viewport_width_a4_portrait_default_margins() {
        // A4 portrait = 210 mm wide, margins L+R = 15+15 = 30 mm,
        // content = 180 mm = 7.0866 inch ≈ 680 CSS px.
        let job = job_with(PaperSize::A4, Orientation::Portrait, Margins::default());
        let w = paper_content_viewport_width(&job);
        assert_eq!(w, 680.0);
    }

    #[test]
    fn viewport_width_a4_landscape_swaps_dims() {
        // A4 landscape = 297 mm wide, content = 267 mm = 10.512 inch ≈ 1009 CSS px.
        let job = job_with(PaperSize::A4, Orientation::Landscape, Margins::default());
        let w = paper_content_viewport_width(&job);
        assert_eq!(w, 1009.0);
    }

    #[test]
    fn viewport_width_floors_at_50mm_for_extreme_margins() {
        // Margins eat the whole sheet → fall back to 50 mm content area.
        // 50 mm = 1.9685 inch ≈ 189 CSS px.
        let job = job_with(
            PaperSize::A4,
            Orientation::Portrait,
            Margins { top: 0.0, right: 200.0, bottom: 0.0, left: 200.0 },
        );
        let w = paper_content_viewport_width(&job);
        assert_eq!(w, 189.0);
    }

    #[test]
    fn viewport_width_letter_portrait() {
        // US Letter = 215.9 mm wide, content = 185.9 mm = 7.319 inch ≈ 703 CSS px.
        let job = job_with(PaperSize::Letter, Orientation::Portrait, Margins::default());
        let w = paper_content_viewport_width(&job);
        assert_eq!(w, 703.0);
    }
}
