//! The popup protocol v1: one JSON object per line, both ways (the notch's
//! `OpenedbotHostedProtocol` 1).
//!
//! Added within v1, each side tolerating a peer that predates it: `features`
//! in `ready` (what the popup can do beyond v1, `demo` for now), `demo` and
//! `endDemo` from the host, `demoEnded` from the popup. The host sends `demo`
//! only to a popup that announced it.

use serde::{Deserialize, Serialize};

use super::MAX_LINE_LENGTH;

const MAX_PATH_LENGTH: usize = 1024;

/// Popup -> host.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PopupToHost {
    Ready {
        protocol: u32,
        version: String,
        /// Absent from a popup that predates it: no feature.
        #[serde(default)]
        features: Vec<String>,
    },
    Token { id: String, #[serde(default)] force: bool },
    OpenConsole { path: String },
    SignOut,
    Fatal { code: String },
    /// The scripted demo stopped by itself (its cycles played, or the user
    /// touched it and its cycle ended); the popup keeps its last frame.
    DemoEnded,
}

/// The feature a popup announces when it can play the scripted demo.
pub const DEMO_FEATURE: &str = "demo";
/// At most this many features of at most 32 characters each.
const MAX_FEATURES: usize = 16;

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
    /// Where the self-update stands (`UpdateState::summary`): `idle`,
    /// `checking`, `available`, `downloading`, `ready`, `installing`, `error`
    /// or `required` (which wins over the others); `version` is the ready
    /// one, or the minimum when required. Sent on each change and after
    /// `hello`. Added within v1: a popup that does not know it drops the line
    /// (logged, nothing else), and one that does ignores an unknown status.
    UpdateState { status: &'static str, version: Option<String> },
    /// Plays the scripted demo (fictional bots, no network) instead of the
    /// session's bots, until `endDemo`. `cycles`: how many loops before it
    /// stops by itself (`demoEnded`); 0 loops until the user touches it.
    /// Sent before the session state on a fresh start, so that the popup
    /// never shows the real bots first.
    Demo { cycles: u32 },
    /// Back to the session's bots (or to nothing, signed out).
    EndDemo,
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

/// A feature name: 1 to 32 lowercase ASCII letters.
fn valid_feature(feature: &str) -> bool {
    (1..=32).contains(&feature.len()) && feature.bytes().all(|byte| byte.is_ascii_lowercase())
}

/// Parses one line read from the popup. Unknown fields are ignored (forward compatible).
pub fn parse_popup_message(line: &str) -> Result<PopupToHost, ParseFailure> {
    if line.len() > MAX_LINE_LENGTH {
        return Err(ParseFailure::TooLong);
    }
    let value: serde_json::Value = serde_json::from_str(line).map_err(|_| ParseFailure::InvalidJson)?;
    let kind = value.get("type").and_then(|kind| kind.as_str()).ok_or(ParseFailure::InvalidJson)?;
    if !matches!(kind, "ready" | "token" | "openConsole" | "signOut" | "fatal" | "demoEnded") {
        return Err(ParseFailure::UnknownType);
    }
    let message: PopupToHost = serde_json::from_value(value).map_err(|_| ParseFailure::InvalidFields)?;
    let valid = match &message {
        PopupToHost::Ready { version, features, .. } => {
            (1..=64).contains(&version.len()) && features.len() <= MAX_FEATURES && features.iter().all(|feature| valid_feature(feature))
        }
        PopupToHost::Token { id, .. } => valid_id(id),
        PopupToHost::OpenConsole { path } => (1..=MAX_PATH_LENGTH).contains(&path.len()),
        PopupToHost::SignOut => true,
        PopupToHost::Fatal { code } => valid_code(code),
        PopupToHost::DemoEnded => true,
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
