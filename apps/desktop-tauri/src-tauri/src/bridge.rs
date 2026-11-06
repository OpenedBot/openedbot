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

use crate::auth::{AuthService, HttpAuthApi, Persistence, SigninState};
use crate::config::ShellConfig;
use crate::vault::Vault;

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
    pub platform: String,
    pub version: String,
    pub bridge_version: u32,
    pub persistence: Persistence,
}

/// Pushed to the console's `/login` on every sign-in state change.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct SigninStateChanged(pub SigninState);

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

/// Opens an https page of the public console or of the API in the system
/// browser (http only for an origin configured as a lab host).
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
    if origin != config.public_console_url && origin != config.api_origin {
        return Err(refused());
    }
    Ok(url)
}

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

/// Google sign-in is not part of the D2a prototype (D2b).
#[tauri::command]
#[specta::specta]
pub fn start_google() -> Result<(), BridgeError> {
    Err(BridgeError::new("NOT_SUPPORTED", "Google sign-in is not available in this preview."))
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
        platform: std::env::consts::OS.to_string(),
        version: shell.version.clone(),
        bridge_version: BRIDGE_VERSION,
        persistence: shell.auth.persistence(),
    }
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
        ])
        .events(tauri_specta::collect_events![SigninStateChanged])
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
