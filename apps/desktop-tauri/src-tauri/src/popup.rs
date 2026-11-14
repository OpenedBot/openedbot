//! Host of the notch popup (OpenedBot/openedbot-notch), protocol v1 over the
//! popup's stdin/stdout (`popup/protocol.rs`): one JSON object per line, an
//! unknown protocol version ends the session, a malformed line is dropped and
//! logged without its content, the refresh token never crosses this channel
//! and no token is ever logged.
//!
//! Life cycle: one launch, then up to `MAX_FAILURES` restarts with a growing
//! delay; a missing or incompatible bundle stops at once.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

use crate::auth::{AccessGrant, ApiError};

mod protocol;
pub use protocol::{encode_host_message, parse_popup_message, resolve_console_path, HostToPopup, ParseFailure, PopupToHost, DEMO_FEATURE};

pub const PROTOCOL_VERSION: u32 = 1;
/// Longest line either side accepts. Real messages are a few hundred bytes.
pub const MAX_LINE_LENGTH: usize = 16 * 1024;
pub const BUNDLE_NAME: &str = "OpenedbotPopup.app";
const EXECUTABLE: &str = "Contents/MacOS/OpenedbotPopup";
const STOP_GRACE: Duration = Duration::from_secs(2);

/// How long the host waits and how often it restarts (`popup-host.ts`):
/// one launch, then up to `max_failures` restarts with a doubling delay; a
/// run that lasted `healthy_run` resets the count.
#[derive(Debug, Clone, Copy)]
pub struct Policy {
    pub ready_timeout: Duration,
    pub max_failures: u32,
    pub restart_base: Duration,
    pub restart_cap: Duration,
    pub healthy_run: Duration,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            ready_timeout: Duration::from_secs(10),
            max_failures: 5,
            restart_base: Duration::from_secs(1),
            restart_cap: Duration::from_secs(16),
            healthy_run: Duration::from_secs(60),
        }
    }
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

/// The features a bundle declares (`OpenedbotHostedFeatures`, an array of
/// strings in its Info.plist): what the host may count on before the popup
/// runs. Its `ready` has the last word.
pub fn read_hosted_features(bundle: &Path) -> Vec<String> {
    let Ok(plist) = std::fs::read_to_string(bundle.join("Contents/Info.plist")) else { return Vec::new() };
    let Some(after) = plist.split("<key>OpenedbotHostedFeatures</key>").nth(1) else { return Vec::new() };
    let Some(array) = after.trim_start().strip_prefix("<array>").and_then(|rest| rest.split("</array>").next()) else { return Vec::new() };
    array.split("<string>").skip(1).filter_map(|item| item.split("</string>").next()).map(|item| item.trim().to_string()).collect()
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
    /// "Quit" from the popup's own menu: the user no longer wants it.
    fn user_closed(&self) {}
    /// Lines sent after `hello` and the session state, so that a popup that
    /// (re)starts learns what it missed (the update state).
    fn greeting(&self) -> Vec<HostToPopup> {
        Vec::new()
    }
    /// The popup's `ready` said whether it plays the demo, and that differs
    /// from what was known (the bundle's declaration, or an earlier run). A
    /// demo asked of a popup that cannot play it is dropped first.
    fn demo_support_changed(&self, _supported: bool) {}
    /// The demo stopped by itself (`demoEnded`); the popup holds its last frame.
    fn demo_ended(&self) {}
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
    /// The demo to play, its cycles (0: until the user touches it); sent
    /// after `hello`, before the session state, on every (re)start.
    demo: Option<u32>,
    /// Whether the popup plays the demo: the bundle's declaration, then each `ready`.
    demo_supported: bool,
    /// The run that has said `ready` (and got `hello`). A line may go to the
    /// popup only when it is the current run: a replacement launched before
    /// the old process exited is not ready until its own `ready`.
    ready_run: Option<u64>,
    /// An update replaces the bundle: no start until released.
    held: bool,
    /// The run that owns `sender` and `stop`: a run that ends late (stopped,
    /// then started again) must not clear its successor's channel.
    run: u64,
    sender: Option<mpsc::UnboundedSender<HostToPopup>>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
}

impl State {
    fn is_ready(&self) -> bool {
        self.ready_run == Some(self.run)
    }
}

pub struct PopupHost<T: TokenSource> {
    bundle: Option<PathBuf>,
    api_origin: String,
    console_url: String,
    tokens: Arc<T>,
    events: Arc<dyn PopupEvents>,
    policy: Policy,
    state: Mutex<State>,
    /// How many popup processes exist (launching included): the updater
    /// waits for 0 before it replaces the bundle that holds the executable.
    running: tokio::sync::watch::Sender<usize>,
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
        Self::with_policy(bundle, api_origin, console_url, tokens, events, Policy::default())
    }

    pub fn with_policy(bundle: Option<PathBuf>, api_origin: &str, console_url: &str, tokens: Arc<T>, events: Arc<dyn PopupEvents>, policy: Policy) -> Arc<Self> {
        let demo_supported = bundle.as_deref().is_some_and(|bundle| read_hosted_features(bundle).iter().any(|feature| feature == DEMO_FEATURE));
        Arc::new(Self {
            bundle,
            api_origin: api_origin.into(),
            console_url: console_url.into(),
            tokens,
            events,
            policy,
            state: Mutex::new(State { wanted: false, demo: None, demo_supported, ready_run: None, held: false, run: 0, sender: None, stop: None }),
            running: tokio::sync::watch::channel(0).0,
        })
    }

    /// A bundle was found (the menu greys the popup modes otherwise).
    pub fn available(&self) -> bool {
        self.bundle.is_some()
    }

    /// Stops the popup and waits, at most `limit`, until its process has
    /// exited. `true` when no popup process remains.
    pub async fn stop_and_wait(&self, limit: Duration) -> bool {
        self.stop();
        let mut running = self.running.subscribe();
        tokio::time::timeout(limit, running.wait_for(|running| *running == 0)).await.is_ok_and(|waited| waited.is_ok())
    }

    /// One launch is over (spawn failed, stopped, or exited). Runs may
    /// overlap (stopped, then started before the old process exited): the
    /// count reaches 0 only once every one of them is gone.
    fn release_run(&self) {
        self.running.send_modify(|running| *running = running.saturating_sub(1));
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Stops the popup and refuses every `start` until `release`, then waits
    /// for its exit like `stop_and_wait`: the updater replaces the bundle
    /// that holds the executable meanwhile.
    pub async fn hold_and_wait(&self, limit: Duration) -> bool {
        self.lock().held = true;
        self.stop_and_wait(limit).await
    }

    /// Lifts `hold_and_wait`; the caller starts the popup again if wanted.
    pub fn release(&self) {
        self.lock().held = false;
    }

    /// Keeps a popup running from now on (idempotent; ignored while held). Must be called inside the async runtime.
    pub fn start(self: &Arc<Self>) {
        {
            let mut state = self.lock();
            if state.held {
                log::info!("popup start deferred: an update replaces the bundle");
                return;
            }
            if state.wanted {
                return;
            }
            state.wanted = true;
        }
        let host = self.clone();
        tauri::async_runtime::spawn(async move { host.supervise().await });
    }

    /// Whether the popup plays the scripted demo (bundle declaration, then its `ready`).
    pub fn demo_supported(&self) -> bool {
        self.lock().demo_supported
    }

    /// A demo is asked of the popup (playing, or waiting for its `ready`).
    pub fn demo_active(&self) -> bool {
        self.lock().demo.is_some()
    }

    /// Plays the scripted demo from its start, the popup started if it was
    /// not. `false` (nothing done) when the popup cannot play it.
    pub fn play_demo(self: &Arc<Self>, cycles: u32) -> bool {
        {
            let mut state = self.lock();
            if !state.demo_supported {
                return false;
            }
            state.demo = Some(cycles);
            if state.is_ready() {
                if let Some(sender) = &state.sender {
                    let _ = sender.send(HostToPopup::Demo { cycles });
                }
            }
        }
        self.start();
        true
    }

    /// Back to the session's bots; the popup keeps running.
    pub fn end_demo(&self) {
        let mut state = self.lock();
        if state.demo.take().is_some() && state.is_ready() {
            if let Some(sender) = &state.sender {
                let _ = sender.send(HostToPopup::EndDemo);
            }
        }
    }

    /// Stops it and keeps it stopped (idempotent); a demo asked is dropped.
    pub fn stop(&self) {
        let mut state = self.lock();
        state.wanted = false;
        state.demo = None;
        state.ready_run = None;
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
                    self.events.user_closed();
                    return;
                }
                RunEnd::Refused(reason) => {
                    self.give_up(reason);
                    return;
                }
                RunEnd::Failed { ran_for } => {
                    let policy = self.policy;
                    if ran_for.is_some_and(|ran| ran >= policy.healthy_run) {
                        failures = 0;
                    }
                    failures += 1;
                    if failures > policy.max_failures {
                        self.give_up(GiveUp::Crashing(failures - 1));
                        return;
                    }
                    let delay = policy.restart_base.saturating_mul(2u32.saturating_pow(failures - 1)).min(policy.restart_cap);
                    log::warn!("popup failed ({failures}/{}), restarting in {} ms", policy.max_failures, delay.as_millis());
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
        {
            let state = self.lock();
            if !state.wanted {
                return RunEnd::Stopped;
            }
            // Claimed under the lock `stop` takes: from here a stop waits for
            // this launch to end, even one still being spawned.
            self.running.send_modify(|running| *running += 1);
        }
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
                self.release_run();
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
            if state.wanted {
                state.run += 1;
                state.ready_run = None;
                state.sender = Some(sender.clone());
                state.stop = Some(stop_tx);
                Some(state.run)
            } else {
                None
            }
        };
        let Some(run) = run else {
            // Stopped while it was being spawned.
            let _ = child.start_kill();
            let _ = child.wait().await;
            self.release_run();
            return RunEnd::Stopped;
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
        let ready_deadline = tokio::time::sleep(self.policy.ready_timeout);
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
                                if let Some(end) = self.handle(message, run, &sender, &mut ready_at, &served) {
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
                state.ready_run = None;
            }
        }
        drop(sender);
        writer.abort();
        self.release_run();
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
        run: u64,
        sender: &mpsc::UnboundedSender<HostToPopup>,
        ready_at: &mut Option<Instant>,
        served: &Arc<Mutex<Option<String>>>,
    ) -> Option<GiveUp> {
        if ready_at.is_none() && !matches!(message, PopupToHost::Ready { .. } | PopupToHost::Fatal { .. }) {
            log::warn!("popup message before ready ignored");
            return None;
        }
        match message {
            PopupToHost::Ready { protocol, version, features } => {
                if protocol != PROTOCOL_VERSION {
                    log::error!("popup speaks protocol {protocol}, expected {PROTOCOL_VERSION}: stopping it");
                    return Some(GiveUp::Protocol(protocol));
                }
                *ready_at = Some(Instant::now());
                let supports_demo = features.iter().any(|feature| feature == DEMO_FEATURE);
                log::info!("popup ready (version {version}, demo {})", if supports_demo { "supported" } else { "unsupported" });
                let greeting = self.events.greeting();
                let signed_in = self.tokens.is_signed_in();
                // Under the lock: a `play_demo` racing this greeting cannot
                // slip its line before `hello`, nor be sent twice.
                let changed = {
                    let mut state = self.lock();
                    // Only the current run owns the handshake: a run replaced
                    // meanwhile is on its way out and must not mark the new
                    // one ready, nor rewrite what it supports.
                    let current = state.run == run;
                    let changed = current && state.demo_supported != supports_demo;
                    if current {
                        state.demo_supported = supports_demo;
                        state.ready_run = Some(run);
                        if !supports_demo && state.demo.take().is_some() {
                            log::warn!("this popup does not play the demo: demo dropped");
                        }
                    }
                    let _ = sender.send(HostToPopup::Hello {
                        protocol: PROTOCOL_VERSION,
                        api_origin: self.api_origin.clone(),
                        console_url: self.console_url.clone(),
                    });
                    // Before the session state: the real bots never show first.
                    if let Some(cycles) = state.demo.filter(|_| current) {
                        let _ = sender.send(HostToPopup::Demo { cycles });
                    }
                    let _ = sender.send(if signed_in { HostToPopup::SignedIn } else { HostToPopup::SignedOut });
                    for line in greeting {
                        let _ = sender.send(line);
                    }
                    changed
                };
                if changed {
                    self.events.demo_support_changed(supports_demo);
                }
                None
            }
            PopupToHost::DemoEnded => {
                // A replaced or stopped run's late line says nothing about the current one.
                let current = {
                    let state = self.lock();
                    state.wanted && state.is_ready() && state.run == run
                };
                if current {
                    log::info!("popup demo ended");
                    self.events.demo_ended();
                } else {
                    log::info!("demo end from a replaced popup run ignored");
                }
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
mod tests;
