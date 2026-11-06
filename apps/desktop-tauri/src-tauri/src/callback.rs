//! The browser's way back after a Google sign-in, as in the Electron shell
//! (`apps/desktop/src/main/deep-link.ts`): the `openedbot://auth/callback`
//! deep link when the app owns that scheme, otherwise a loopback page on
//! `127.0.0.1:47813`. Both URIs are the only ones the API accepts as
//! `redirectUri` (`nativeRedirectUris`, `platform/config/src/api-config.ts`).
//!
//! Either way the callback only means "the browser step is over": the claim
//! polled by `auth/google.rs` is what authenticates. Its query (code, state)
//! is neither read nor logged.

use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const SCHEME: &str = "openedbot";
pub const PROTOCOL_REDIRECT_URI: &str = "openedbot://auth/callback";
pub const LOOPBACK_PORT: u16 = 47813;
pub const LOOPBACK_REDIRECT_URI: &str = "http://127.0.0.1:47813/callback";

/// The scheme this build declares to the OS (`plugins.deep-link.desktop.schemes`
/// of `tauri.conf.json`, checked by a test). The preview declares none: it
/// must never take `openedbot://` from the installed Electron app, so it
/// always uses the loopback page.
pub const DECLARED_SCHEME: Option<&str> = None;

/// The redirect URI to announce to the API, decided once at startup: the deep
/// link only when the scheme is really ours, the loopback page otherwise.
pub fn redirect_uri(scheme_registered: bool) -> &'static str {
    if scheme_registered {
        PROTOCOL_REDIRECT_URI
    } else {
        LOOPBACK_REDIRECT_URI
    }
}

/// Only the shape is checked; the query is never read.
pub fn is_auth_callback(raw: &str) -> bool {
    raw.starts_with(PROTOCOL_REDIRECT_URI) && raw[PROTOCOL_REDIRECT_URI.len()..].chars().next().is_none_or(|next| next == '?' || next == '#' || next == '/')
}

const PAGE: &str = "<!doctype html><meta charset=utf-8><title>openedbot</title>\
<body style=\"font-family:system-ui;margin:3rem\"><h1>Connexion terminée</h1>\
<p>Vous pouvez fermer cet onglet et revenir à openedbot.</p></body>";
/// Longest request head read; a real browser request is well under this.
const MAX_REQUEST: usize = 8 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(5);

struct Running {
    owner: u64,
    port: u16,
    stop: tokio::sync::oneshot::Sender<()>,
}

/// The loopback listener: up while a Google attempt waits, on 127.0.0.1 only.
pub struct Loopback {
    port: u16,
    on_callback: Arc<dyn Fn() + Send + Sync>,
    running: Mutex<Option<Running>>,
}

impl Loopback {
    /// `port` 0 picks a free port (tests).
    pub fn new(port: u16, on_callback: Arc<dyn Fn() + Send + Sync>) -> Self {
        Self { port, on_callback, running: Mutex::new(None) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Running>> {
        self.running.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Starts listening for `owner` (an attempt), or hands a running listener
    /// over to it. Must run inside the async runtime. Fails when the port is taken.
    pub fn start(&self, owner: u64) -> std::io::Result<u16> {
        let mut running = self.lock();
        if let Some(current) = running.as_mut() {
            current.owner = owner;
            return Ok(current.port);
        }
        let listener = std::net::TcpListener::bind(("127.0.0.1", self.port))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let listener = tokio::net::TcpListener::from_std(listener)?;
        let (stop, stopped) = tokio::sync::oneshot::channel();
        tokio::spawn(serve(listener, self.on_callback.clone(), stopped));
        *running = Some(Running { owner, port, stop });
        Ok(port)
    }

    /// Stops the listener if `owner` still owns it (a newer attempt keeps it).
    pub fn stop(&self, owner: u64) {
        let mut running = self.lock();
        if running.as_ref().is_some_and(|current| current.owner == owner) {
            if let Some(current) = running.take() {
                let _ = current.stop.send(());
            }
        }
    }

    pub fn is_running(&self) -> bool {
        self.lock().is_some()
    }
}

async fn serve(listener: tokio::net::TcpListener, on_callback: Arc<dyn Fn() + Send + Sync>, mut stopped: tokio::sync::oneshot::Receiver<()>) {
    loop {
        tokio::select! {
            _ = &mut stopped => return,
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { continue };
                let on_callback = on_callback.clone();
                tokio::spawn(async move {
                    if answer(stream).await {
                        on_callback();
                    }
                });
            }
        }
    }
}

/// Answers one request; `true` when it was the callback.
async fn answer(mut stream: tokio::net::TcpStream) -> bool {
    let mut head = Vec::with_capacity(1024);
    let mut buffer = [0u8; 1024];
    let read = tokio::time::timeout(READ_TIMEOUT, async {
        while !head.windows(4).any(|window| window == b"\r\n\r\n") && head.len() < MAX_REQUEST {
            let count = stream.read(&mut buffer).await?;
            if count == 0 {
                break;
            }
            head.extend_from_slice(&buffer[..count]);
        }
        Ok::<_, std::io::Error>(())
    })
    .await;
    if !matches!(read, Ok(Ok(()))) {
        return false;
    }
    let is_callback = is_callback_request(&head);
    let response = if is_callback {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{PAGE}",
            PAGE.len()
        )
    } else {
        "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string()
    };
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
    is_callback
}

/// `GET /callback` (any query) and nothing else.
pub fn is_callback_request(head: &[u8]) -> bool {
    let Some(line) = head.split(|byte| *byte == b'\r' || *byte == b'\n').next() else { return false };
    let mut parts = line.split(|byte| *byte == b' ');
    let (Some(method), Some(target)) = (parts.next(), parts.next()) else { return false };
    let path = target.split(|byte| *byte == b'?').next().unwrap_or_default();
    method == b"GET" && path == b"/callback"
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn an_unregistered_deep_link_falls_back_to_the_loopback_page() {
        assert_eq!(redirect_uri(false), LOOPBACK_REDIRECT_URI);
        assert_eq!(redirect_uri(true), PROTOCOL_REDIRECT_URI);
        // The preview never claims the scheme of the installed Electron app.
        assert_eq!(redirect_uri(DECLARED_SCHEME == Some(SCHEME)), LOOPBACK_REDIRECT_URI);
    }

    #[test]
    fn the_declared_scheme_matches_the_bundle_configuration() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let schemes: Vec<String> = config["plugins"]["deep-link"]["desktop"]["schemes"]
            .as_array()
            .map(|list| list.iter().filter_map(|value| value.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        assert_eq!(schemes, DECLARED_SCHEME.map(|scheme| vec![scheme.to_string()]).unwrap_or_default());
    }

    #[test]
    fn recognises_the_callback_shapes_only() {
        assert!(is_auth_callback("openedbot://auth/callback?code=x&state=y"));
        assert!(is_auth_callback("openedbot://auth/callback"));
        assert!(!is_auth_callback("openedbot://auth/callbackevil"));
        assert!(!is_auth_callback("openedbot://other"));
        assert!(is_callback_request(b"GET /callback?code=x HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"));
        assert!(!is_callback_request(b"POST /callback HTTP/1.1\r\n\r\n"));
        assert!(!is_callback_request(b"GET /callback/x HTTP/1.1\r\n\r\n"));
        assert!(!is_callback_request(b"GET / HTTP/1.1\r\n\r\n"));
    }

    async fn get(port: u16, path: &str) -> String {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes()).await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response
    }

    #[tokio::test]
    async fn the_loopback_page_wakes_the_attempt_and_stops_with_its_owner() {
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        let loopback = Loopback::new(0, Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        }));
        let port = loopback.start(1).unwrap();
        assert!(get(port, "/nope").await.starts_with("HTTP/1.1 404"));
        let page = get(port, "/callback?code=secret&state=s").await;
        assert!(page.starts_with("HTTP/1.1 200") && page.contains("Connexion terminée"));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        // A newer attempt takes the listener over: the older one cannot stop it.
        assert_eq!(loopback.start(2).unwrap(), port);
        loopback.stop(1);
        assert!(loopback.is_running());
        loopback.stop(2);
        assert!(!loopback.is_running());
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_err());
    }

    #[tokio::test]
    async fn a_busy_port_is_reported() {
        let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = taken.local_addr().unwrap().port();
        let loopback = Loopback::new(port, Arc::new(|| {}));
        assert!(loopback.start(1).is_err());
    }
}
