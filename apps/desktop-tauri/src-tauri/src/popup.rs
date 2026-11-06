//! Host of the notch popup (OpenedBot/openedbot-notch), protocol v1 over the
//! popup's stdin/stdout. Port of the Electron shell's
//! `apps/desktop/src/main/popup-host.ts` and `src/shared/popup-protocol.ts`:
//! one JSON object per line, an unknown protocol version ends the session, a
//! malformed line is dropped and logged without its content, the refresh
//! token never crosses this channel and no token is ever logged.
//!
//! Life cycle: one launch, then up to `MAX_FAILURES` restarts with a growing
//! delay; a missing or incompatible bundle stops at once.

use serde::{Deserialize, Serialize};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

use crate::auth::{AccessGrant, ApiError};

pub const PROTOCOL_VERSION: u32 = 1;
/// Longest line either side accepts. Real messages are a few hundred bytes.
pub const MAX_LINE_LENGTH: usize = 16 * 1024;
pub const BUNDLE_NAME: &str = "OpenedbotPopup.app";
const EXECUTABLE: &str = "Contents/MacOS/OpenedbotPopup";
const READY_TIMEOUT: Duration = Duration::from_secs(10);
const STOP_GRACE: Duration = Duration::from_secs(2);
const MAX_FAILURES: u32 = 5;
const RESTART_BASE: Duration = Duration::from_secs(1);
const RESTART_CAP: Duration = Duration::from_secs(16);
const HEALTHY_RUN: Duration = Duration::from_secs(60);
const MAX_PATH_LENGTH: usize = 1024;

/// Popup -> host.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PopupToHost {
    Ready { protocol: u32, version: String },
    Token { id: String, #[serde(default)] force: bool },
    OpenConsole { path: String },
    SignOut,
    Fatal { code: String },
}

/// Host -> popup. Serialized field by field: nothing else can leak.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum HostToPopup {
    #[serde(rename_all = "camelCase")]
    Hello { protocol: u32, api_origin: String, console_url: String },
    #[serde(rename_all = "camelCase")]
    Token {
        id: String,
        access_token: Option<String>,
        expires_at: Option<String>,
        organization_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<&'static str>,
    },
    SignedOut,
    SignedIn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseFailure {
    TooLong,
    InvalidJson,
    UnknownType,
    InvalidFields,
}

fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn valid_code(code: &str) -> bool {
    let bytes = code.as_bytes();
    (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_uppercase()
        && bytes.iter().all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || *byte == b'_')
}

/// Parses one line read from the popup. Unknown fields are ignored (forward compatible).
pub fn parse_popup_message(line: &str) -> Result<PopupToHost, ParseFailure> {
    if line.len() > MAX_LINE_LENGTH {
        return Err(ParseFailure::TooLong);
    }
    let value: serde_json::Value = serde_json::from_str(line).map_err(|_| ParseFailure::InvalidJson)?;
    let kind = value.get("type").and_then(|kind| kind.as_str()).ok_or(ParseFailure::InvalidJson)?;
    if !matches!(kind, "ready" | "token" | "openConsole" | "signOut" | "fatal") {
        return Err(ParseFailure::UnknownType);
    }
    let message: PopupToHost = serde_json::from_value(value).map_err(|_| ParseFailure::InvalidFields)?;
    let valid = match &message {
        PopupToHost::Ready { version, .. } => (1..=64).contains(&version.len()),
        PopupToHost::Token { id, .. } => valid_id(id),
        PopupToHost::OpenConsole { path } => (1..=MAX_PATH_LENGTH).contains(&path.len()),
        PopupToHost::SignOut => true,
        PopupToHost::Fatal { code } => valid_code(code),
    };
    if valid {
        Ok(message)
    } else {
        Err(ParseFailure::InvalidFields)
    }
}

pub fn encode_host_message(message: &HostToPopup) -> String {
    let mut line = serde_json::to_string(message).expect("host message serializes");
    line.push('\n');
    line
}

/// A console path asked by the popup, or `None`. Only a plain absolute path
/// qualifies: no scheme, no `//host`, no backslash or control character, no
/// `..` segment. The shell then opens it on its local origin.
pub fn resolve_console_path(path: &str) -> Option<String> {
    if path.is_empty() || path.len() > MAX_PATH_LENGTH || !path.starts_with('/') || path.starts_with("//") {
        return None;
    }
    if path.chars().any(|c| c == '\\' || c.is_control()) {
        return None;
    }
    let route = path.split(['?', '#']).next().unwrap_or("");
    if route.split('/').any(|segment| segment == ".." || segment == ".") {
        return None;
    }
    Some(path.to_string())
}

/// The protocol a bundle declares (`OpenedbotHostedProtocol` in its
/// Info.plist, XML as written by `make bundle` in openedbot-notch). `None`: a
/// build from before hosted mode, which would ignore `--hosted`.
pub fn read_hosted_protocol(bundle: &Path) -> Option<u32> {
    let plist = std::fs::read_to_string(bundle.join("Contents/Info.plist")).ok()?;
    let after = plist.split("<key>OpenedbotHostedProtocol</key>").nth(1)?;
    let value = after.trim_start().strip_prefix("<integer>")?;
    value.split("</integer>").next()?.trim().parse().ok()
}

/// The popup bundle: `Contents/Helpers` of the running app when packaged,
/// otherwise `OPENEDBOT_POPUP_APP` (development).
pub fn locate_bundle(executable: &Path, env_override: Option<PathBuf>) -> Option<PathBuf> {
    let packaged = executable.parent()?.parent().map(|contents| contents.join("Helpers").join(BUNDLE_NAME));
    [packaged, env_override].into_iter().flatten().find(|candidate| candidate.join(EXECUTABLE).is_file())
}

/// What the popup needs from the session.
pub trait TokenSource: Send + Sync + 'static {
    fn read_access(&self, force: bool, served: Option<String>) -> impl Future<Output = Result<Option<AccessGrant>, ApiError>> + Send;
    fn is_signed_in(&self) -> bool;
    fn sign_out(&self) -> impl Future<Output = ()> + Send;
}

/// What the host tells the shell.
pub trait PopupEvents: Send + Sync + 'static {
    /// `openConsole` from the popup, already checked.
    fn open_console(&self, path: &str);
    /// The popup cannot run (missing, crash loop, refused): fall back to the window.
    fn gave_up(&self, reason: &GiveUp);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GiveUp {
    Missing,
    Protocol(u32),
    Fatal(String),
    Crashing(u32),
}

struct State {
    wanted: bool,
    /// The run that owns `sender` and `stop`: a run that ends late (stopped,
    /// then started again) must not clear its successor's channel.
    run: u64,
    sender: Option<mpsc::UnboundedSender<HostToPopup>>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
}

pub struct PopupHost<T: TokenSource> {
    bundle: Option<PathBuf>,
    api_origin: String,
    console_url: String,
    tokens: Arc<T>,
    events: Arc<dyn PopupEvents>,
    state: Mutex<State>,
}

enum RunEnd {
    /// Stopped on purpose (stdin closed by us).
    Stopped,
    /// "Quit" from the popup's own menu: clean exit after ready.
    UserClosed,
    Refused(GiveUp),
    Failed { ran_for: Option<Duration> },
}

impl<T: TokenSource> PopupHost<T> {
    pub fn new(bundle: Option<PathBuf>, api_origin: &str, console_url: &str, tokens: Arc<T>, events: Arc<dyn PopupEvents>) -> Arc<Self> {
        Arc::new(Self {
            bundle,
            api_origin: api_origin.into(),
            console_url: console_url.into(),
            tokens,
            events,
            state: Mutex::new(State { wanted: false, run: 0, sender: None, stop: None }),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Keeps a popup running from now on (idempotent). Must be called inside the async runtime.
    pub fn start(self: &Arc<Self>) {
        {
            let mut state = self.lock();
            if state.wanted {
                return;
            }
            state.wanted = true;
        }
        let host = self.clone();
        tauri::async_runtime::spawn(async move { host.supervise().await });
    }

    /// Stops it and keeps it stopped (idempotent).
    pub fn stop(&self) {
        let mut state = self.lock();
        state.wanted = false;
        state.sender = None;
        if let Some(stop) = state.stop.take() {
            let _ = stop.send(());
        }
    }

    pub fn notify(&self, message: HostToPopup) {
        if let Some(sender) = &self.lock().sender {
            let _ = sender.send(message);
        }
    }

    async fn supervise(self: Arc<Self>) {
        let Some(bundle) = self.bundle.clone() else {
            self.give_up(GiveUp::Missing);
            return;
        };
        let declared = read_hosted_protocol(&bundle);
        if declared != Some(PROTOCOL_VERSION) {
            self.give_up(GiveUp::Protocol(declared.unwrap_or(0)));
            return;
        }
        let mut failures = 0u32;
        while self.lock().wanted {
            match self.run_once(&bundle).await {
                RunEnd::Stopped => return,
                RunEnd::UserClosed => {
                    self.lock().wanted = false;
                    log::info!("popup closed by the user");
                    return;
                }
                RunEnd::Refused(reason) => {
                    self.give_up(reason);
                    return;
                }
                RunEnd::Failed { ran_for } => {
                    if ran_for.is_some_and(|ran| ran >= HEALTHY_RUN) {
                        failures = 0;
                    }
                    failures += 1;
                    if failures > MAX_FAILURES {
                        self.give_up(GiveUp::Crashing(failures - 1));
                        return;
                    }
                    let delay = RESTART_BASE.saturating_mul(2u32.saturating_pow(failures - 1)).min(RESTART_CAP);
                    log::warn!("popup failed ({failures}/{MAX_FAILURES}), restarting in {} ms", delay.as_millis());
                    tokio::time::sleep(delay).await;
                }
            }
        }
    }

    fn give_up(&self, reason: GiveUp) {
        self.lock().wanted = false;
        log::error!("popup disabled: {reason:?}");
        self.events.gave_up(&reason);
    }

    async fn run_once(self: &Arc<Self>, bundle: &Path) -> RunEnd {
        let spawned = Command::new(bundle.join(EXECUTABLE))
            .arg("--hosted")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // The popup's own logs never touch the protocol.
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn();
        let mut child: Child = match spawned {
            Ok(child) => child,
            Err(error) => {
                log::error!("popup spawn failed ({})", error.kind());
                return RunEnd::Failed { ran_for: None };
            }
        };
        log::info!("popup started");
        let mut stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let (sender, mut outbox) = mpsc::unbounded_channel::<HostToPopup>();
        let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
        let run = {
            let mut state = self.lock();
            if !state.wanted {
                return RunEnd::Stopped;
            }
            state.run += 1;
            state.sender = Some(sender.clone());
            state.stop = Some(stop_tx);
            state.run
        };

        // One writer: replies from several token tasks never interleave.
        let writer = tauri::async_runtime::spawn(async move {
            while let Some(message) = outbox.recv().await {
                if stdin.write_all(encode_host_message(&message).as_bytes()).await.is_err() {
                    log::warn!("popup channel write failed");
                    break;
                }
            }
            // Dropping stdin is EOF: the popup's polite stop.
        });

        let mut reader = BufReader::new(stdout);
        let mut line = Vec::new();
        let mut ready_at: Option<Instant> = None;
        let mut refusal: Option<GiveUp> = None;
        let served: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let ready_deadline = tokio::time::sleep(READY_TIMEOUT);
        tokio::pin!(ready_deadline);
        let mut stopping = false;

        let status = loop {
            line.clear();
            tokio::select! {
                _ = &mut stop_rx, if !stopping => {
                    stopping = true;
                    {
                        let mut state = self.lock();
                        if state.run == run {
                            state.sender = None;
                        }
                    }
                    // Dropping the writer drops stdin: EOF is the popup's polite stop.
                    writer.abort();
                    let _ = tokio::time::timeout(STOP_GRACE, child.wait()).await;
                    let _ = child.start_kill();
                    break child.wait().await.ok();
                }
                _ = &mut ready_deadline, if ready_at.is_none() && refusal.is_none() => {
                    log::error!("popup never sent ready: stopping it");
                    let _ = child.start_kill();
                    break child.wait().await.ok();
                }
                read = read_bounded_line(&mut reader, &mut line) => match read {
                    Ok(0) => break child.wait().await.ok(),
                    Ok(_) => {
                        let Ok(text) = std::str::from_utf8(&line) else {
                            log::warn!("popup line ignored (not UTF-8)");
                            continue;
                        };
                        let text = text.trim_end_matches(['\n', '\r']);
                        if text.trim().is_empty() {
                            continue;
                        }
                        if line.len() > MAX_LINE_LENGTH {
                            log::warn!("popup line ignored (too long)");
                            continue;
                        }
                        match parse_popup_message(text) {
                            Err(reason) => log::warn!("popup line ignored ({reason:?})"),
                            Ok(message) => {
                                if let Some(end) = self.handle(message, &sender, &mut ready_at, &served) {
                                    refusal = Some(end);
                                    // Not waiting for EOF: a process the popup
                                    // spawned may still hold its stdout open.
                                    let _ = child.start_kill();
                                    break child.wait().await.ok();
                                }
                            }
                        }
                    }
                    Err(_) => break child.wait().await.ok(),
                },
            }
        };
        {
            let mut state = self.lock();
            if state.run == run {
                state.sender = None;
                state.stop = None;
            }
        }
        drop(sender);
        writer.abort();
        log::info!("popup exited ({})", status.map(|status| status.to_string()).unwrap_or_else(|| "unknown".into()));
        if stopping || !self.lock().wanted || self.lock().run != run {
            return RunEnd::Stopped;
        }
        if let Some(reason) = refusal {
            return RunEnd::Refused(reason);
        }
        if ready_at.is_some() && status.is_some_and(|status| status.success()) {
            return RunEnd::UserClosed;
        }
        RunEnd::Failed { ran_for: ready_at.map(|at| at.elapsed()) }
    }

    /// Handles one message; returns a refusal that ends the run.
    fn handle(
        self: &Arc<Self>,
        message: PopupToHost,
        sender: &mpsc::UnboundedSender<HostToPopup>,
        ready_at: &mut Option<Instant>,
        served: &Arc<Mutex<Option<String>>>,
    ) -> Option<GiveUp> {
        if ready_at.is_none() && !matches!(message, PopupToHost::Ready { .. } | PopupToHost::Fatal { .. }) {
            log::warn!("popup message before ready ignored");
            return None;
        }
        match message {
            PopupToHost::Ready { protocol, version } => {
                if protocol != PROTOCOL_VERSION {
                    log::error!("popup speaks protocol {protocol}, expected {PROTOCOL_VERSION}: stopping it");
                    return Some(GiveUp::Protocol(protocol));
                }
                *ready_at = Some(Instant::now());
                log::info!("popup ready (version {version})");
                let _ = sender.send(HostToPopup::Hello {
                    protocol: PROTOCOL_VERSION,
                    api_origin: self.api_origin.clone(),
                    console_url: self.console_url.clone(),
                });
                let _ = sender.send(if self.tokens.is_signed_in() { HostToPopup::SignedIn } else { HostToPopup::SignedOut });
                None
            }
            PopupToHost::Token { id, force } => {
                let tokens = self.tokens.clone();
                let sender = sender.clone();
                let served = served.clone();
                tauri::async_runtime::spawn(async move {
                    let last = served.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
                    let reply = match tokens.read_access(force, last).await {
                        Ok(grant) => {
                            if let Some(grant) = &grant {
                                *served.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(grant.access_token.clone());
                            }
                            log::info!("token served to the popup ({})", if grant.is_some() { "signed in" } else { "signed out" });
                            HostToPopup::Token {
                                id,
                                access_token: grant.as_ref().map(|grant| grant.access_token.clone()),
                                expires_at: grant.as_ref().map(|grant| grant.expires_at.clone()),
                                organization_id: grant.and_then(|grant| grant.organization_id),
                                error: None,
                            }
                        }
                        Err(error) => {
                            log::warn!("token for the popup unavailable ({error})");
                            HostToPopup::Token { id, access_token: None, expires_at: None, organization_id: None, error: Some("unavailable") }
                        }
                    };
                    let _ = sender.send(reply);
                });
                None
            }
            PopupToHost::OpenConsole { path } => {
                match resolve_console_path(&path) {
                    Some(path) => self.events.open_console(&path),
                    None => log::warn!("popup asked for a console path that is not allowed"),
                }
                None
            }
            PopupToHost::SignOut => {
                let tokens = self.tokens.clone();
                tauri::async_runtime::spawn(async move { tokens.sign_out().await });
                None
            }
            PopupToHost::Fatal { code } => {
                log::error!("popup refused to run: {code}");
                Some(GiveUp::Fatal(code))
            }
        }
    }
}

/// Reads one line, keeping at most `MAX_LINE_LENGTH + 1` bytes of it: an
/// overlong line is consumed to its newline but never buffered without bound.
async fn read_bounded_line<R: tokio::io::AsyncBufRead + Unpin>(reader: &mut R, line: &mut Vec<u8>) -> std::io::Result<usize> {
    let mut total = 0usize;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(total);
        }
        let (chunk, done) = match available.iter().position(|byte| *byte == b'\n') {
            Some(index) => (&available[..=index], true),
            None => (available, false),
        };
        let room = (MAX_LINE_LENGTH + 1).saturating_sub(line.len());
        line.extend_from_slice(&chunk[..chunk.len().min(room)]);
        let used = chunk.len();
        total += used;
        reader.consume(used);
        if done {
            return Ok(total);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn parses_the_popup_messages_and_rejects_the_rest() {
        assert_eq!(
            parse_popup_message(r#"{"type":"ready","protocol":1,"version":"1.2.0","extra":true}"#),
            Ok(PopupToHost::Ready { protocol: 1, version: "1.2.0".into() })
        );
        assert_eq!(parse_popup_message(r#"{"type":"token","id":"t-1"}"#), Ok(PopupToHost::Token { id: "t-1".into(), force: false }));
        assert_eq!(parse_popup_message(r#"{"type":"token","id":"bad id"}"#), Err(ParseFailure::InvalidFields));
        assert_eq!(parse_popup_message(r#"{"type":"fatal","code":"lower"}"#), Err(ParseFailure::InvalidFields));
        assert_eq!(parse_popup_message(r#"{"type":"steal"}"#), Err(ParseFailure::UnknownType));
        assert_eq!(parse_popup_message("not json"), Err(ParseFailure::InvalidJson));
        assert_eq!(parse_popup_message(&"x".repeat(MAX_LINE_LENGTH + 1)), Err(ParseFailure::TooLong));
    }

    #[test]
    fn encodes_host_messages_on_one_line() {
        let hello = encode_host_message(&HostToPopup::Hello { protocol: 1, api_origin: "http://127.0.0.1:8790".into(), console_url: "x".into() });
        assert_eq!(hello, "{\"type\":\"hello\",\"protocol\":1,\"apiOrigin\":\"http://127.0.0.1:8790\",\"consoleUrl\":\"x\"}\n");
        let token = encode_host_message(&HostToPopup::Token { id: "a".into(), access_token: None, expires_at: None, organization_id: None, error: Some("unavailable") });
        assert_eq!(token, "{\"type\":\"token\",\"id\":\"a\",\"accessToken\":null,\"expiresAt\":null,\"organizationId\":null,\"error\":\"unavailable\"}\n");
        assert_eq!(encode_host_message(&HostToPopup::SignedIn), "{\"type\":\"signedIn\"}\n");
    }

    #[test]
    fn console_paths_stay_plain_and_absolute() {
        assert_eq!(resolve_console_path("/compact/bot-1?x=1#y").as_deref(), Some("/compact/bot-1?x=1#y"));
        for refused in ["", "compact", "//evil.com", "/a\\b", "/a/../b", "/a\nb", "https://evil.com"] {
            assert_eq!(resolve_console_path(refused), None, "{refused:?}");
        }
    }

    struct Tokens {
        served: AtomicUsize,
    }

    impl TokenSource for Tokens {
        async fn read_access(&self, _force: bool, _served: Option<String>) -> Result<Option<AccessGrant>, ApiError> {
            self.served.fetch_add(1, Ordering::SeqCst);
            Ok(Some(AccessGrant { access_token: "access".into(), expires_at: "2099-01-01T00:00:00Z".into(), organization_id: Some("org".into()) }))
        }
        fn is_signed_in(&self) -> bool {
            true
        }
        async fn sign_out(&self) {}
    }

    #[derive(Default)]
    struct Events {
        opened: Mutex<Vec<String>>,
        gave_up: Mutex<Vec<GiveUp>>,
    }

    impl PopupEvents for Events {
        fn open_console(&self, path: &str) {
            self.opened.lock().unwrap().push(path.into());
        }
        fn gave_up(&self, reason: &GiveUp) {
            self.gave_up.lock().unwrap().push(reason.clone());
        }
    }

    /// A fake popup bundle: a shell script speaking the protocol.
    fn fake_bundle(name: &str, protocol: u32, script: &str) -> PathBuf {
        let bundle = std::env::temp_dir().join(format!("openedbot-popup-test-{}-{name}", std::process::id())).join(BUNDLE_NAME);
        std::fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
        std::fs::write(
            bundle.join("Contents/Info.plist"),
            format!("<plist><dict><key>OpenedbotHostedProtocol</key>\n  <integer>{protocol}</integer></dict></plist>"),
        )
        .unwrap();
        let executable = bundle.join(EXECUTABLE);
        std::fs::write(&executable, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        bundle
    }

    #[test]
    fn reads_the_declared_protocol() {
        let bundle = fake_bundle("plist", 1, "exit 0");
        assert_eq!(read_hosted_protocol(&bundle), Some(1));
        assert_eq!(read_hosted_protocol(Path::new("/nonexistent")), None);
    }

    #[tokio::test]
    async fn hosts_a_popup_through_ready_hello_and_a_token() {
        // Answers ready, then asks for a token and a console path once it got
        // hello and the session state, then echoes the token reply to a file.
        let out = std::env::temp_dir().join(format!("openedbot-popup-test-{}-out", std::process::id()));
        let script = format!(
            r#"echo '{{"type":"ready","protocol":1,"version":"test"}}'
read hello; read state
echo '{{"type":"token","id":"t1"}}'
echo '{{"type":"openConsole","path":"/compact/bot-1"}}'
echo '{{"type":"openConsole","path":"//evil"}}'
read reply
printf '%s\n%s\n%s\n' "$hello" "$state" "$reply" > '{}'
read eof
exit 0"#,
            out.display()
        );
        let bundle = fake_bundle("happy", 1, &script);
        let tokens = Arc::new(Tokens { served: AtomicUsize::new(0) });
        let events = Arc::new(Events::default());
        let host = PopupHost::new(Some(bundle), "http://127.0.0.1:8790", "http://localhost:1420", tokens.clone(), events.clone());
        host.start();
        for _ in 0..100 {
            if out.exists() && std::fs::read_to_string(&out).unwrap().lines().count() == 3 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let written = std::fs::read_to_string(&out).expect("the fake popup wrote what it received");
        let lines: Vec<&str> = written.lines().collect();
        assert_eq!(lines[0], r#"{"type":"hello","protocol":1,"apiOrigin":"http://127.0.0.1:8790","consoleUrl":"http://localhost:1420"}"#);
        assert_eq!(lines[1], r#"{"type":"signedIn"}"#);
        assert!(lines[2].contains(r#""id":"t1""#) && lines[2].contains(r#""organizationId":"org""#));
        assert_eq!(tokens.served.load(Ordering::SeqCst), 1);
        assert_eq!(*events.opened.lock().unwrap(), vec!["/compact/bot-1".to_string()]);
        host.stop();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(events.gave_up.lock().unwrap().is_empty());
        let _ = std::fs::remove_file(out);
    }

    #[tokio::test]
    async fn an_incompatible_or_missing_bundle_is_given_up_at_once() {
        let events = Arc::new(Events::default());
        let tokens = Arc::new(Tokens { served: AtomicUsize::new(0) });
        let old = fake_bundle("old", 2, "exit 0");
        PopupHost::new(Some(old), "a", "b", tokens.clone(), events.clone()).start();
        PopupHost::new(None, "a", "b", tokens, events.clone()).start();
        tokio::time::sleep(Duration::from_millis(100)).await;
        let reasons = events.gave_up.lock().unwrap().clone();
        assert!(reasons.contains(&GiveUp::Protocol(2)));
        assert!(reasons.contains(&GiveUp::Missing));
    }

    #[tokio::test]
    async fn a_popup_that_refuses_is_not_restarted() {
        let events = Arc::new(Events::default());
        let tokens = Arc::new(Tokens { served: AtomicUsize::new(0) });
        let bundle = fake_bundle("fatal", 1, r#"echo '{"type":"fatal","code":"UNSUPPORTED_OS"}'; sleep 5"#);
        PopupHost::new(Some(bundle), "a", "b", tokens, events.clone()).start();
        for _ in 0..60 {
            if !events.gave_up.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(*events.gave_up.lock().unwrap(), vec![GiveUp::Fatal("UNSUPPORTED_OS".into())]);
    }
}
