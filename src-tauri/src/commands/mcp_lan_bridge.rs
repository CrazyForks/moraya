//! LAN bridge for local MCP servers.
//!
//! Exposes a stdio MCP server (managed by `MCPProcessManager`) over the local
//! network as a token-gated, **plain-JSON** HTTP JSON-RPC endpoint, so the
//! mobile app (which can't spawn local processes) can consume PC-local MCP
//! containers on the same Wi-Fi.
//!
//! Design constraints (see iteration doc):
//! - **No streaming.** The mobile client runs `CapacitorHttp`, which can't read
//!   a streamed body — so every response is a single `application/json` blob
//!   (MCP "Streamable HTTP" without SSE framing). The mobile MCP client already
//!   parses a plain-JSON response when `Content-Type` isn't `text/event-stream`.
//! - **Per-server opt-in + bearer token.** Nothing is exposed by default; each
//!   server the user toggles on gets a fresh random token. The HTTP server binds
//!   `0.0.0.0` (LAN-reachable) but rejects any request without the matching
//!   `Authorization: Bearer <token>`.
//! - **Tiny footprint.** `tiny_http` (synchronous) over a dedicated thread; the
//!   handler calls `forward_request_blocking` directly (it's already blocking).

use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::commands::mcp::{forward_request_blocking, MCPProcessManager};

const START_PORT: u16 = 8765;
const PORT_SCAN: u16 = 20;
const MAX_BODY: usize = 1024 * 1024; // 1 MB cap on a JSON-RPC request body

#[derive(Serialize)]
pub struct ExposeInfo {
    pub url: String,
    pub token: String,
    pub port: u16,
}

#[derive(Serialize)]
pub struct ExposeRow {
    pub server_id: String,
    pub url: String,
    /// Returned so the (trusted, same-machine) UI can re-display the connection
    /// card after the panel is reopened within the same app session.
    pub token: String,
}

struct RunState {
    running: bool,
    port: u16,
}

/// Managed Tauri state. Holds the shared token registry + the HTTP server's
/// run state. The actual `tiny_http::Server` lives on its own thread.
pub struct LanBridge {
    /// serverId -> bearer token. Shared (Arc) with the server thread for auth.
    registry: Arc<Mutex<HashMap<String, String>>>,
    /// Set true to ask the server thread to exit (checked each recv cycle).
    stop_flag: Arc<AtomicBool>,
    run: Mutex<RunState>,
}

impl LanBridge {
    pub fn new() -> Self {
        Self {
            registry: Arc::new(Mutex::new(HashMap::new())),
            stop_flag: Arc::new(AtomicBool::new(false)),
            run: Mutex::new(RunState { running: false, port: 0 }),
        }
    }

    /// Start the HTTP server thread if it isn't already running. Returns the port.
    fn ensure_started(&self, app: AppHandle) -> Result<u16, String> {
        let mut run = self.run.lock().map_err(|e| e.to_string())?;
        if run.running {
            return Ok(run.port);
        }
        let (server, port) = bind_server(START_PORT)?;
        self.stop_flag.store(false, Ordering::Relaxed);

        let registry = self.registry.clone();
        let stop = self.stop_flag.clone();
        std::thread::spawn(move || {
            loop {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                match server.recv_timeout(Duration::from_millis(500)) {
                    Ok(Some(req)) => handle_request(req, &registry, &app),
                    Ok(None) => continue, // timeout — re-check stop flag
                    Err(_) => break,
                }
            }
            // `server` dropped here → listening socket closed.
        });

        run.running = true;
        run.port = port;
        Ok(port)
    }

    /// Stop the server thread when nothing is exposed anymore (no idle listener).
    fn maybe_stop(&self) {
        let empty = self.registry.lock().map(|r| r.is_empty()).unwrap_or(true);
        if empty {
            self.stop_flag.store(true, Ordering::Relaxed);
            if let Ok(mut run) = self.run.lock() {
                run.running = false;
                run.port = 0;
            }
        }
    }

    fn current_port(&self) -> Option<u16> {
        self.run.lock().ok().and_then(|r| if r.running { Some(r.port) } else { None })
    }
}

impl Default for LanBridge {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tauri commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn mcp_lan_expose(
    app: AppHandle,
    state: State<'_, LanBridge>,
    server_id: String,
) -> Result<ExposeInfo, String> {
    let port = state.ensure_started(app)?;
    let token = gen_token();
    state
        .registry
        .lock()
        .map_err(|e| e.to_string())?
        .insert(server_id.clone(), token.clone());
    let ip = lan_ip();
    Ok(ExposeInfo {
        url: format!("http://{}:{}/mcp/{}", ip, port, server_id),
        token,
        port,
    })
}

#[tauri::command]
pub fn mcp_lan_unexpose(state: State<'_, LanBridge>, server_id: String) -> Result<(), String> {
    state
        .registry
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&server_id);
    state.maybe_stop();
    Ok(())
}

#[tauri::command]
pub fn mcp_lan_status(state: State<'_, LanBridge>) -> Result<Vec<ExposeRow>, String> {
    let port = match state.current_port() {
        Some(p) => p,
        None => return Ok(vec![]),
    };
    let ip = lan_ip();
    let reg = state.registry.lock().map_err(|e| e.to_string())?;
    Ok(reg
        .iter()
        .map(|(id, token)| ExposeRow {
            server_id: id.clone(),
            url: format!("http://{}:{}/mcp/{}", ip, port, id),
            token: token.clone(),
        })
        .collect())
}

// ── HTTP handling ───────────────────────────────────────────────────────────

fn handle_request(
    mut req: tiny_http::Request,
    registry: &Arc<Mutex<HashMap<String, String>>>,
    app: &AppHandle,
) {
    // CORS preflight — the Capacitor WebView origin differs from the LAN host.
    if req.method() == &tiny_http::Method::Options {
        respond(req, 200, String::new());
        return;
    }
    if req.method() != &tiny_http::Method::Post {
        respond(req, 404, json_err("not found"));
        return;
    }

    // Path: /mcp/{serverId}
    let server_id = match server_id_from_path(req.url()) {
        Some(id) => id,
        None => {
            respond(req, 404, json_err("unknown endpoint"));
            return;
        }
    };

    // Bearer token must match the one minted for this server.
    let bearer = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("Authorization"))
        .map(|h| h.value.as_str().to_string())
        .unwrap_or_default();
    let token = bearer_token(&bearer).to_string();
    let authorized = registry
        .lock()
        .ok()
        .and_then(|r| r.get(&server_id).cloned())
        .map(|expected| ct_eq(&expected, &token))
        .unwrap_or(false);
    if !authorized {
        respond(req, 401, json_err("unauthorized"));
        return;
    }

    // Body = a single JSON-RPC request (capped).
    let mut body = String::new();
    if req
        .as_reader()
        .take(MAX_BODY as u64)
        .read_to_string(&mut body)
        .is_err()
    {
        respond(req, 400, json_err("invalid request body"));
        return;
    }

    // Forward to the stdio MCP child and return its JSON-RPC response verbatim.
    let mgr = app.state::<MCPProcessManager>();
    match forward_request_blocking(mgr.inner(), &server_id, body.trim()) {
        Ok(json) => respond(req, 200, json),
        Err(e) => respond(req, 502, json_err(&e)),
    }
}

fn respond(req: tiny_http::Request, status: u16, body: String) {
    let resp = tiny_http::Response::from_string(body)
        .with_status_code(status)
        .with_header(header("Content-Type", "application/json"))
        .with_header(header("Access-Control-Allow-Origin", "*"))
        .with_header(header("Access-Control-Allow-Methods", "POST, OPTIONS"))
        .with_header(header("Access-Control-Allow-Headers", "authorization, content-type"));
    let _ = req.respond(resp);
}

fn header(key: &str, value: &str) -> tiny_http::Header {
    // Static keys/values — from_bytes only fails on invalid header chars.
    tiny_http::Header::from_bytes(key.as_bytes(), value.as_bytes())
        .unwrap_or_else(|_| tiny_http::Header::from_bytes(&b"X-Moraya"[..], &b"1"[..]).unwrap())
}

fn json_err(msg: &str) -> String {
    serde_json::json!({ "error": msg }).to_string()
}

/// Extract `{serverId}` from a `/mcp/{serverId}` request URL (query stripped).
/// Returns None for any other path or an empty id.
fn server_id_from_path(url: &str) -> Option<String> {
    let path = url.split('?').next().unwrap_or("");
    match path.strip_prefix("/mcp/") {
        Some(id) if !id.is_empty() && !id.contains('/') => Some(id.to_string()),
        _ => None,
    }
}

/// Pull the token out of an `Authorization: Bearer <token>` header value.
fn bearer_token(header_value: &str) -> &str {
    header_value.strip_prefix("Bearer ").unwrap_or("").trim()
}

// ── helpers ─────────────────────────────────────────────────────────────────

fn lan_ip() -> String {
    local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| "0.0.0.0".to_string())
}

fn gen_token() -> String {
    let mut buf = [0u8; 24]; // 192-bit token
    getrandom::getrandom(&mut buf).expect("getrandom failed");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

fn bind_server(start: u16) -> Result<(tiny_http::Server, u16), String> {
    for port in start..start.saturating_add(PORT_SCAN) {
        if let Ok(server) = tiny_http::Server::http(("0.0.0.0", port)) {
            return Ok((server, port));
        }
    }
    Err("MCP LAN bridge: no free port available".to_string())
}

/// Constant-time string compare (avoid token timing leaks; no extra crate).
fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_server_id_from_valid_path() {
        assert_eq!(server_id_from_path("/mcp/abc-123"), Some("abc-123".to_string()));
        assert_eq!(server_id_from_path("/mcp/abc?x=1"), Some("abc".to_string()));
    }

    #[test]
    fn rejects_bad_paths() {
        assert_eq!(server_id_from_path("/mcp/"), None);
        assert_eq!(server_id_from_path("/other/abc"), None);
        assert_eq!(server_id_from_path("/mcp/a/b"), None); // no nested segments
        assert_eq!(server_id_from_path("/"), None);
    }

    #[test]
    fn extracts_bearer_token() {
        assert_eq!(bearer_token("Bearer xyz789"), "xyz789");
        assert_eq!(bearer_token("Bearer  spaced  "), "spaced");
        assert_eq!(bearer_token("xyz789"), ""); // missing scheme
        assert_eq!(bearer_token(""), "");
    }

    #[test]
    fn ct_eq_matches_only_equal_strings() {
        assert!(ct_eq("token-abc", "token-abc"));
        assert!(!ct_eq("token-abc", "token-abd"));
        assert!(!ct_eq("short", "longer"));
        assert!(ct_eq("", ""));
    }

    #[test]
    fn tokens_are_unique_and_url_safe() {
        let a = gen_token();
        let b = gen_token();
        assert_ne!(a, b);
        assert!(a.len() >= 30); // 24 random bytes → 32 base64url chars
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }
}
