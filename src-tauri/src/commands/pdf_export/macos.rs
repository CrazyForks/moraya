//! macOS native PDF export via WKWebView `createPDFWithConfiguration:completionHandler:`.
//!
//! Flow:
//!   1. Create hidden WebviewWindow at the paper content width so WebKit lays
//!      out text at the correct line-break width for the chosen paper size.
//!   2. Register a oneshot ready-signal in PdfExportState.
//!   3. eval `window.__moraya_print.render(payload)` to hydrate content.
//!   4. Wait for the frontend to call `export_print_ready(job_id)`.
//!   5. Expand the window to the full document scroll-height so WebKit tiles
//!      (pre-renders) all content — fixes truncation on long documents.
//!   6. Call WKWebView createPDF; receive NSData → Vec<u8>.
//!   7. Write bytes to output_path and destroy the hidden window.

#![cfg(target_os = "macos")]

use std::ffi::CString;
use std::sync::mpsc::sync_channel;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use super::{paper_full_viewport_width, JobConfig, ProgressEvent};

const READY_TIMEOUT: Duration = Duration::from_secs(30);
const CREATE_PDF_TIMEOUT: Duration = Duration::from_secs(120);

pub async fn run(
    app: AppHandle,
    job: &JobConfig,
    progress: &Channel<ProgressEvent>,
) -> Result<(), String> {
    let label = format!("moraya-print-{}", &job.job_id);

    // ---- 1. spawn hidden window at the FULL paper width ----
    // WKWebView `createPDF` sizes the PDF page to the frame and ignores CSS
    // `@page`, so we render at the full paper width and inset the content with
    // CSS padding (= margins) after render — giving real A4 page margins.
    // Height starts at 900 px; we expand after render completes (step 5).
    let viewport_w = paper_full_viewport_width(job);
    // The window MUST be `visible(true)` — a `visible(false)` (orderedOut)
    // NSWindow has an empty visibleRect, so WKWebView suspends layer rendering
    // and `createPDF` captures BLANK pages (all of them). We park it far
    // off-screen (-9999,-9999) so the user never sees it, and `focused(false)`
    // keeps it from stealing key focus from the editor.
    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("print/".into()))
        .visible(true)
        .focused(false)
        .inner_size(viewport_w, 900.0)
        .position(-9999.0, -9999.0)
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .build()
        .map_err(|e| format!("hidden window build failed: {e}"))?;

    // Always clean up the hidden window on exit, even on error.
    let cleanup = WindowGuard {
        window: Some(window.clone()),
    };

    // ---- 2. register ready oneshot BEFORE injecting render() ----
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<()>();
    {
        let state = app.state::<super::PdfExportState>();
        let mut senders = state
            .ready_senders
            .lock()
            .map_err(|e| format!("ready_senders lock: {e}"))?;
        senders.insert(job.job_id.clone(), ready_tx);
    }

    // ---- 3. inject render call after a brief settle delay ----
    let payload = serde_json::to_string(job).map_err(|e| format!("serialize job: {e}"))?;
    let _ = progress.send(ProgressEvent::Rendering);

    // Wait up to ~300 ms for SvelteKit onMount to run and set
    // window.__moraya_print.  Five × 60 ms is more than enough.
    for _ in 0..5 {
        tokio::time::sleep(Duration::from_millis(60)).await;
    }

    let render_call = format!(
        "(async()=>{{try{{await window.__moraya_print.render({payload});}}catch(e){{console.error('print render failed',e);}}}})()"
    );
    window
        .eval(&render_call)
        .map_err(|e| format!("eval render: {e}"))?;

    // ---- 4. wait for export_print_ready ----
    match tokio::time::timeout(READY_TIMEOUT, ready_rx).await {
        Ok(Ok(())) => {}
        Ok(Err(_)) => return Err("ready signal cancelled".to_string()),
        Err(_) => {
            let state = app.state::<super::PdfExportState>();
            if let Ok(mut s) = state.ready_senders.lock() {
                s.remove(&job.job_id);
            }
            return Err("render handshake timeout (30s)".to_string());
        }
    }

    // ---- 4b. inset content by the configured margins ----
    // The frame IS the PDF page (createPDF ignores @page), and the frame is now
    // the FULL paper width, so pad the content by the margins to produce real
    // A4 whitespace. Also hard-hides the debug status overlay from the capture.
    // Runs BEFORE height expansion so scrollHeight already includes the padding.
    let m = &job.options.margins;
    let margin_style = format!(
        "(()=>{{try{{let s=document.getElementById('__moraya_print_margins');if(!s){{s=document.createElement('style');s.id='__moraya_print_margins';document.head.appendChild(s);}}s.textContent='.print-root{{padding:{t}mm {r}mm {b}mm {l}mm !important;box-sizing:border-box}} .print-status{{display:none !important}}';}}catch(e){{}}}})()",
        t = m.top, r = m.right, b = m.bottom, l = m.left
    );
    let _ = window.eval(&margin_style);
    // Let WebKit reflow at the new padding before measuring the full height.
    tokio::time::sleep(Duration::from_millis(50)).await;

    // ---- 5. expand WKWebView frame to full document height ----
    // WKWebView lays out content at the view's frame size.  createPDF uses
    // this layout, so the frame must cover the full scrollable height before
    // we call it — otherwise the PDF is truncated at ~10× viewport (≈8 pages
    // for a 900 px window).  We resize the WKWebView frame directly via
    // setFrameSize: rather than window.set_size() to avoid allocating a flat
    // NSWindow IOSurface (2–3 GB for 200 pages) that triggers macOS memory
    // pressure and corrupts the main editor window.
    let _ = progress.send(ProgressEvent::Rendering); // "Laying out…"
    expand_to_full_height(&window, viewport_w).await;

    // ---- 6. invoke WKWebView createPDF ----
    // For long documents this takes 10–60 s; signal Writing so the status
    // bar shows activity throughout.
    let _ = progress.send(ProgressEvent::Writing);
    let pdf_bytes = create_pdf_via_wkwebview(&window).await?;

    if pdf_bytes.is_empty() {
        return Err("createPDF returned empty data".to_string());
    }

    // ---- 7. write to disk ----
    write_pdf_bytes(&job.output_path, &pdf_bytes)?;

    let _ = progress.send(ProgressEvent::Done);
    drop(cleanup);
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// RAII guard: destroy the hidden window when the export job finishes.
struct WindowGuard {
    window: Option<tauri::WebviewWindow>,
}

impl Drop for WindowGuard {
    fn drop(&mut self) {
        if let Some(w) = self.window.take() {
            let _ = w.destroy();
        }
    }
}

/// Evaluate a JavaScript expression that returns a number and collect the
/// result via `evaluateJavaScript:completionHandler:`.
async fn eval_number(window: &tauri::WebviewWindow, js: &str) -> Result<f64, String> {
    use block::ConcreteBlock;
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};

    let c_js = CString::new(js).map_err(|_| "null byte in js".to_string())?;
    let (tx, rx) = sync_channel::<f64>(1);
    let tx2 = tx.clone();

    window
        .with_webview(move |webview| {
            // SAFETY: `webview.inner()` returns the WKWebView* owned by
            // this window.  The window is kept alive by `WindowGuard` for
            // the duration of the export, so the pointer is valid here.
            unsafe {
                let wk: *mut Object = webview.inner() as *mut Object;
                if wk.is_null() {
                    let _ = tx2.send(0.0);
                    return;
                }
                let js_str: *mut Object =
                    msg_send![class!(NSString), stringWithUTF8String: c_js.as_ptr()];

                let tx3 = tx2.clone();
                let blk = ConcreteBlock::new(
                    move |result: *mut Object, _error: *mut Object| {
                        let v: f64 = if result.is_null() {
                            0.0
                        } else {
                            msg_send![result, doubleValue]
                        };
                        let _ = tx3.send(v);
                    },
                );
                let blk = blk.copy();
                let _: () =
                    msg_send![wk, evaluateJavaScript: js_str completionHandler: &*blk];
            }
        })
        .map_err(|e| format!("with_webview (eval_number): {e}"))?;

    tokio::task::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(10)))
        .await
        .map_err(|e| format!("join eval_number: {e}"))?
        .map_err(|_| "eval_number timeout".to_string())
}

/// Expand the WKWebView frame to the full document scroll-height so WebKit
/// computes layout for all content before `createPDF` is called.
///
/// **Why `setFrameSize:` and not `window.set_size()`**:
/// `window.set_size()` resizes the NSWindow backing store (a flat IOSurface).
/// For a 200-page document (≈224 000 px) that buffer is ~2–3 GB; macOS
/// immediately applies memory pressure which blanks or kills the main editor
/// window's shared WebContent process.
/// `[WKWebView setFrameSize:]` resizes only the view's layout frame.  WKWebView
/// uses tiled rendering internally so tiles are allocated lazily near the
/// current scroll position — the total memory footprint is unaffected.
/// The NSWindow backing store stays at 900 px and the main window is safe.
async fn expand_to_full_height(window: &tauri::WebviewWindow, viewport_w: f64) {
    let scroll_h = match eval_number(window, "document.documentElement.scrollHeight").await {
        Ok(h) if h > 0.0 => h,
        _ => return, // best-effort; proceed at current size
    };

    // +120 px safety margin avoids rounding clips at the very bottom of the
    // last page.
    let full_h = scroll_h.ceil() + 120.0;
    if full_h <= 900.0 {
        return; // content already fits; no resize needed
    }

    // NSSize is 16 bytes (2 × f64). On x86_64 both doubles go in XMM regs;
    // on ARM64 they go in d0/d1 — both ABIs handled correctly by objc_msgSend.
    #[repr(C)]
    struct NSSize {
        width: f64,
        height: f64,
    }

    let _ = window.with_webview(move |webview| {
        use objc::runtime::Object;
        use objc::{msg_send, sel, sel_impl};
        // SAFETY: `webview.inner()` returns the WKWebView* for this window.
        // NSSize is repr(C) and matches the Objective-C NSSize layout exactly.
        unsafe {
            let wk: *mut Object = webview.inner() as *mut Object;
            if wk.is_null() {
                return;
            }
            let size = NSSize {
                width: viewport_w,
                height: full_h,
            };
            let _: () = msg_send![wk, setFrameSize: size];
        }
    });

    // Give WebKit one layout pass at the expanded frame before createPDF.
    // Scale delay with document length: 100 ms base + 0.5 µs per extra px.
    let extra_px = (full_h - 900.0).max(0.0);
    let delay_ms = (100.0 + extra_px * 0.0005).min(1500.0) as u64;
    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
}

fn write_pdf_bytes(path: &str, bytes: &[u8]) -> Result<(), String> {
    use crate::commands::file as file_cmd;
    use std::fs;
    use std::io::Write;

    let safe_path = file_cmd::validate_path(path)?;
    if let Some(parent) = safe_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir parent: {e}"))?;
    }
    let mut f = fs::File::create(&safe_path).map_err(|e| format!("create file: {e}"))?;
    f.write_all(bytes).map_err(|e| format!("write bytes: {e}"))?;
    Ok(())
}

/// Call WKWebView `createPDFWithConfiguration:completionHandler:` and collect
/// the resulting NSData into a `Vec<u8>`.
async fn create_pdf_via_wkwebview(window: &tauri::WebviewWindow) -> Result<Vec<u8>, String> {
    use block::ConcreteBlock;
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};

    let (tx, rx) = sync_channel::<Result<Vec<u8>, String>>(1);
    let tx2 = tx.clone();

    window
        .with_webview(move |webview| {
            // SAFETY: WKWebView pointer is valid; window outlives this
            // closure because WindowGuard holds a clone until after rx.recv.
            unsafe {
                let wk: *mut Object = webview.inner() as *mut Object;
                if wk.is_null() {
                    let _ = tx2.send(Err("wkwebview pointer is null".to_string()));
                    return;
                }

                let cfg_cls = class!(WKPDFConfiguration);
                let config: *mut Object = msg_send![cfg_cls, new];

                let tx3 = tx2.clone();
                let block = ConcreteBlock::new(
                    move |data: *mut Object, error: *mut Object| {
                        if !error.is_null() {
                            let _ = tx3
                                .send(Err("WKWebView createPDF reported error".to_string()));
                            return;
                        }
                        if data.is_null() {
                            let _ =
                                tx3.send(Err("WKWebView createPDF returned nil data".to_string()));
                            return;
                        }
                        let len: usize = msg_send![data, length];
                        let ptr: *const u8 = msg_send![data, bytes];
                        // SAFETY: ptr/len come from NSData and are valid for
                        // the duration of this block call.
                        let bytes = std::slice::from_raw_parts(ptr, len).to_vec();
                        let _ = tx3.send(Ok(bytes));
                    },
                );
                let block = block.copy();

                let _: () = msg_send![
                    wk,
                    createPDFWithConfiguration: config
                    completionHandler: &*block
                ];
            }
        })
        .map_err(|e| format!("with_webview (createPDF): {e}"))?;

    tokio::task::spawn_blocking(move || rx.recv_timeout(CREATE_PDF_TIMEOUT))
        .await
        .map_err(|e| format!("join createPDF: {e}"))?
        .map_err(|_| "createPDF timeout (120s)".to_string())?
}
