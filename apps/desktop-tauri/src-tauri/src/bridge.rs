//! The native bridge: the commands the embedded console may call, and the
//! event it listens to. This file is the contract; `tauri-specta` generates
//! its TypeScript twin in `contracts/native-bridge/src/bindings.ts`
//! (`cargo run --example export-bindings`, checked by `bindings_are_current`).
//!
//! Every command is listed in `build.rs` (`AppManifest::commands`), which
//! makes it deny-by-default; `capabilities/main.json` grants them to the
//! `main` window on the local origin only. A command added here and not
//! there is refused at runtime, and `tests::*_refused` prove the refusal.

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;
use url::Url;

use crate::auth::{AuthService, AuthorizeTargets, GoogleSteps, GoogleTiming, HttpAuthApi, Persistence, SigninState};
use crate::config::ShellConfig;
use crate::diagnostics::{Level, Source};
use crate::update_state::{UpdateState, UpdateStatus};
use crate::vault::Vault;
use crate::window::ThemeMode;

/// Bumped on any breaking change of the commands below; the console reads it
/// from `window.__OPENEDBOT_SHELL__.bridgeVersion`.
pub const BRIDGE_VERSION: u32 = 1;

include!("bridge_commands.rs");

pub type Auth = AuthService<HttpAuthApi, Box<dyn Vault>>;

impl Vault for Box<dyn Vault> {
    fn load(&self) -> Result<Option<String>, crate::vault::VaultError> {
        (**self).load()
    }
    fn save(&self, secret: &str) -> Result<(), crate::vault::VaultError> {
        (**self).save(secret)
    }
    fn clear(&self) -> Result<(), crate::vault::VaultError> {
        (**self).clear()
    }
}

/// Opens a URL in the system browser (the opener plugin in the app, a
/// recorder in tests).
pub type Opener = Box<dyn Fn(&Url) -> Result<(), String> + Send + Sync>;

/// What the commands share. Managed by the app (`app.manage`).
pub struct Shell {
    pub auth: Arc<Auth>,
    pub config: ShellConfig,
    pub version: String,
    pub opener: Opener,
    /// The browser and the loopback listener of a Google attempt.
    pub google: Arc<dyn GoogleSteps>,
    pub client_id: String,
    /// The main window, for the commands that move or paint it.
    pub window: Box<dyn WindowControl>,
}

/// What the page may ask of its window (`window.rs` in the app, a recorder in tests).
pub trait WindowControl: Send + Sync {
    fn set_theme(&self, mode: ThemeMode);
    fn set_text_zoom(&self, factor: f64);
    fn start_drag(&self);
    fn toggle_maximize(&self);
}

/// The operating system the shell runs on (`window.__OPENEDBOT_SHELL__.platform`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Macos,
    Windows,
    Linux,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(target_os = "windows") {
            Self::Windows
        } else if cfg!(target_os = "linux") {
            Self::Linux
        } else {
            Self::Macos
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Macos => "macos",
            Self::Windows => "windows",
            Self::Linux => "linux",
        }
    }
}

/// A named failure the console can tell apart (never a token, never a body).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type, thiserror::Error)]
#[error("{code}")]
pub struct BridgeError {
    pub code: String,
    pub message: String,
}

impl BridgeError {
    fn new(code: &str, message: &str) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

impl From<crate::auth::ApiError> for BridgeError {
    fn from(error: crate::auth::ApiError) -> Self {
        Self::new(if error.status == 0 { "NETWORK" } else { "API_ERROR" }, &error.to_string())
    }
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    pub platform: Platform,
    pub version: String,
    pub bridge_version: u32,
    pub persistence: Persistence,
}

/// Pushed to the console's `/login` on every sign-in state change.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct SigninStateChanged(pub SigninState);

/// A click on a notification the page showed, by the id the page gave it:
/// the page runs that notification's `onclick` (open the conversation).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct NotificationClicked {
    pub id: i32,
}

/// The current access token, refreshed when it is about to expire; `null` signed out.
#[tauri::command]
#[specta::specta]
pub async fn read_access_token(shell: State<'_, Shell>) -> Result<Option<String>, BridgeError> {
    Ok(shell.auth.read_access_token().await?)
}

/// Forces a rotation (single flight); `null` when the refresh is refused.
#[tauri::command]
#[specta::specta]
pub async fn refresh(shell: State<'_, Shell>) -> Result<Option<String>, BridgeError> {
    Ok(shell.auth.refresh().await?)
}

/// Opens an https page of the public console or of the API, or the site's
/// download page, in the system browser (http only for an origin configured
/// as a lab host).
#[tauri::command]
#[specta::specta]
pub fn open_external(shell: State<'_, Shell>, url: String) -> Result<(), BridgeError> {
    let parsed = trusted_external_url(&shell.config, &url)?;
    (shell.opener)(&parsed).map_err(|_| BridgeError::new("OPEN_FAILED", "The system browser could not be opened."))
}

pub fn trusted_external_url(config: &ShellConfig, raw: &str) -> Result<Url, BridgeError> {
    let refused = || BridgeError::new("URL_NOT_ALLOWED", "Only pages of the console or of the API open in the browser.");
    if raw.len() > 4096 {
        return Err(refused());
    }
    let url = Url::parse(raw).map_err(|_| refused())?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err(refused());
    }
    // Config validation already restricts an http origin to a lab host.
    let origin = url.origin().ascii_serialization();
    let download_page = origin == SITE_ORIGIN && DOWNLOAD_PATHS.contains(&url.path()) && url.query().is_none();
    if origin != config.public_console_url && origin != config.api_origin && !download_page {
        return Err(refused());
    }
    Ok(url)
}

/// The site's download pages, which the "update required" screen opens
/// (`apps/console/src/lib/platform/client-update.ts`).
const SITE_ORIGIN: &str = "https://openedbot.app";
const DOWNLOAD_PATHS: [&str; 2] = ["/download", "/fr/download"];

/// Revokes the session and forgets it; the shell then shows `/login`.
#[tauri::command]
#[specta::specta]
pub async fn sign_out(shell: State<'_, Shell>) -> Result<(), BridgeError> {
    shell.auth.sign_out().await;
    Ok(())
}

/// Starts an e-mail code request; the outcome arrives as `SigninStateChanged`.
#[tauri::command]
#[specta::specta]
pub fn request_email_code(shell: State<'_, Shell>, email: String, locale: String) -> Result<(), BridgeError> {
    let locale = if locale == "en" { "en" } else { "fr" }.to_string();
    let auth = shell.auth.clone();
    tauri::async_runtime::spawn(async move { auth.request_email_code(email, locale).await });
    Ok(())
}

/// Checks the code and signs in; failure arrives as `SigninStateChanged`,
/// success replaces the page.
#[tauri::command]
#[specta::specta]
pub fn verify_email_code(shell: State<'_, Shell>, email: String, code: String) -> Result<(), BridgeError> {
    let auth = shell.auth.clone();
    tauri::async_runtime::spawn(async move { auth.verify_email_code(email, code).await });
    Ok(())
}

/// Starts a Google sign-in in the system browser; progress and outcome
/// arrive as `SigninStateChanged`, success replaces the page.
#[tauri::command]
#[specta::specta]
pub fn start_google(shell: State<'_, Shell>) -> Result<(), BridgeError> {
    let auth = shell.auth.clone();
    let google = shell.google.clone();
    let targets = AuthorizeTargets { api_origin: shell.config.api_origin.clone(), console_origin: shell.config.public_console_url.clone() };
    let client_id = shell.client_id.clone();
    tauri::async_runtime::spawn(async move { auth.sign_in_with_google(google.as_ref(), &targets, &client_id, GoogleTiming::default()).await });
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn cancel_sign_in(shell: State<'_, Shell>) {
    shell.auth.cancel_sign_in();
}

/// The last sign-in state, replayed to a listener that subscribes late.
#[tauri::command]
#[specta::specta]
pub fn signin_state(shell: State<'_, Shell>) -> SigninState {
    shell.auth.signin_state()
}

#[tauri::command]
#[specta::specta]
pub fn shell_info(shell: State<'_, Shell>) -> ShellInfo {
    ShellInfo {
        platform: Platform::current(),
        version: shell.version.clone(),
        bridge_version: BRIDGE_VERSION,
        persistence: shell.auth.persistence(),
    }
}

/// The console's theme (`<html data-theme-mode>`): the window's appearance follows.
#[tauri::command]
#[specta::specta]
pub fn set_theme(shell: State<'_, Shell>, mode: ThemeMode) {
    shell.window.set_theme(mode);
}

/// The console's text size as a page zoom (10 to 14 px over 14): the shell
/// zooms the window and keeps the factor for the next launch.
#[tauri::command]
#[specta::specta]
pub fn set_text_zoom(shell: State<'_, Shell>, factor: f64) -> Result<(), BridgeError> {
    if !crate::prefs::is_text_zoom(factor) {
        return Err(BridgeError::new("INVALID_ZOOM", "Unknown text zoom."));
    }
    shell.window.set_text_zoom(factor);
    Ok(())
}

/// A press on the console's top bar: the window follows the pointer (WKWebView
/// has no `-webkit-app-region`).
#[tauri::command]
#[specta::specta]
pub fn start_window_drag(shell: State<'_, Shell>) {
    shell.window.start_drag();
}

/// A double click on the console's top bar: zoom or unzoom the window, as a title bar does.
#[tauri::command]
#[specta::specta]
pub fn toggle_maximize(shell: State<'_, Shell>) {
    shell.window.toggle_maximize();
}

/// Pushed on every change of the update state (progress included).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct UpdateStateChanged(pub UpdateState);

/// Where the self-update stands now.
#[tauri::command]
#[specta::specta]
pub fn update_state(status: State<'_, UpdateStatus>) -> UpdateState {
    status.get()
}

/// Restarts into the installed update; `UPDATE_NOT_READY` unless one is `ready`.
#[tauri::command]
#[specta::specta]
pub fn restart_to_update(status: State<'_, UpdateStatus>) -> Result<(), BridgeError> {
    if status.restart() {
        Ok(())
    } else {
        Err(BridgeError::new("UPDATE_NOT_READY", "No update is ready to apply."))
    }
}

/// A version number as the API names it (`1.1.0`): digits and dots only.
fn is_version(text: &str) -> bool {
    let parts: Vec<&str> = text.split('.').collect();
    (1..=3).contains(&parts.len()) && parts.iter().all(|part| (1..=4).contains(&part.len()) && part.bytes().all(|byte| byte.is_ascii_digit()))
}

/// The API refused this version (426, `minimum` when it named one): the
/// state becomes `required` and the feed is checked now.
#[tauri::command]
#[specta::specta]
pub fn report_update_required(status: State<'_, UpdateStatus>, minimum: Option<String>) -> Result<(), BridgeError> {
    if minimum.as_deref().is_some_and(|minimum| !is_version(minimum)) {
        return Err(BridgeError::new("INVALID_VERSION", "Invalid version."));
    }
    status.required(minimum);
    Ok(())
}

/// The longest text the page may hand to the journal (redacted and cut further there).
const MAX_DIAGNOSTIC: usize = 4096;

/// A page error, a failed API call or a failed load, for the shell's journal
/// (`diagnostics.rs`). The page may not write as the shell itself.
#[tauri::command]
#[specta::specta]
pub fn report_diagnostic(level: Level, source: Source, message: String, detail: Option<String>) -> Result<(), BridgeError> {
    if !matches!(source, Source::Page | Source::Http | Source::Load) || message.len() > MAX_DIAGNOSTIC || detail.as_ref().is_some_and(|detail| detail.len() > MAX_DIAGNOSTIC) {
        return Err(BridgeError::new("INVALID_DIAGNOSTIC", "Diagnostic refused."));
    }
    crate::diagnostics::record(level, source, &message, detail.as_deref());
    Ok(())
}

/// The typed bridge: commands and events, shared by the app and the exporter.
pub fn specta_builder<R: tauri::Runtime>() -> tauri_specta::Builder<R> {
    tauri_specta::Builder::<R>::new()
        .commands(tauri_specta::collect_commands![
            read_access_token,
            refresh,
            open_external,
            sign_out,
            request_email_code,
            verify_email_code,
            start_google,
            cancel_sign_in,
            signin_state,
            shell_info,
            set_theme,
            set_text_zoom,
            start_window_drag,
            toggle_maximize,
            report_diagnostic,
            update_state,
            restart_to_update,
            report_update_required,
        ])
        .events(tauri_specta::collect_events![SigninStateChanged, NotificationClicked, UpdateStateChanged])
}

/// The TypeScript bindings, with the repository's header.
///
/// The tauri-specta output imports `@tauri-apps/api`; a contract imports
/// nothing but zod, so its runtime imports are pointed at the contract's own
/// `runtime.ts`, which the console's adapter fills with `@tauri-apps/api`.
/// The replacements are exact: a tauri-specta upgrade that changes these
/// lines fails here instead of shipping a contract that imports Tauri.
pub fn bindings_typescript() -> String {
    let path = std::env::temp_dir().join(format!("openedbot-bindings-{}.ts", std::process::id()));
    specta_builder::<tauri::Wry>()
        .export(
            specta_typescript::Typescript::default()
                .header("// Generated by apps/desktop-tauri/src-tauri (tauri-specta). Do not edit: run `make desktop-tauri-bindings`.\n"),
            &path,
        )
        .expect("bindings export");
    let text = std::fs::read_to_string(&path).expect("bindings read");
    let _ = std::fs::remove_file(&path);
    let replacements = [
        ("import { invoke as __TAURI_INVOKE } from \"@tauri-apps/api/core\";", "import { invoke as __TAURI_INVOKE } from \"./runtime\";"),
        ("import * as __TAURI_EVENT from \"@tauri-apps/api/event\";", "import * as __TAURI_EVENT from \"./runtime\";"),
        ("import(\"@tauri-apps/api/webview\").Webview | import(\"@tauri-apps/api/window\").Window", "import(\"./runtime\").EventSource"),
    ];
    let mut out = text;
    for (from, to) in replacements {
        assert!(out.contains(from), "tauri-specta output changed: {from:?} not found");
        out = out.replace(from, to);
    }
    assert!(!out.contains("@tauri-apps/"), "the contract must not import @tauri-apps");
    out
}
