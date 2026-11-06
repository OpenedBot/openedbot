//! Runtime configuration of the shell: which API it talks to, which public
//! console its links point at, where it looks for updates.
//!
//! Nothing here is frozen at build time (ADR 0001, 4.3 "Backend configurable"):
//! an environment variable beats `config.json` in the app config directory,
//! which beats the built-in production defaults. Every value must be https,
//! or plain http for a loopback or local-network host only, since the bearer
//! token travels on these URLs.

use serde::Deserialize;
use std::net::Ipv4Addr;
use std::path::Path;
use url::Url;

pub const PRODUCTION_API_ORIGIN: &str = "https://api.openedbot.app";
pub const PRODUCTION_CONSOLE_URL: &str = "https://console.openedbot.app";
/// The hosted update feed of the production app (ADR 0001, Q2): the R2 bucket
/// behind `releases.openedbot.app`, one manifest per variant (`solo`, Q8) and
/// channel, `<base>/<channel>/latest.json`; the artifacts it names are
/// immutable, under `desktop/v<version>/`.
pub const PRODUCTION_UPDATE_BASE: &str = "https://releases.openedbot.app/desktop/solo";

/// Which manifest the production app follows: `stable` by default, `beta`
/// for testers (`updateChannel` in `config.json`, `OPENEDBOT_UPDATE_CHANNEL`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum UpdateChannel {
    #[default]
    Stable,
    Beta,
}

impl UpdateChannel {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "stable" => Some(Self::Stable),
            "beta" => Some(Self::Beta),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Beta => "beta",
        }
    }

    /// The channel's manifest on the hosted feed.
    pub fn manifest_url(self) -> String {
        format!("{PRODUCTION_UPDATE_BASE}/{}/latest.json", self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellConfig {
    /// `scheme://host[:port]`, no path, no trailing slash.
    pub api_origin: String,
    /// The public web console (invitation links, "open in browser"), an origin.
    pub public_console_url: String,
    /// The update manifest; `None` turns the updater off.
    pub update_url: Option<String>,
    /// The notch popup (Contents/Helpers/OpenedbotPopup.app) may run: on by
    /// default, the user then chooses (`notch.rs`). `false` (`OPENEDBOT_POPUP=0`,
    /// `"popup": false` in `config.json`) is a kill switch: the window only,
    /// whatever was chosen, and no first-run choice.
    pub popup: bool,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ConfigError {
    #[error("{0} is not a valid URL")]
    Invalid(&'static str),
    #[error("{0} must be https (http is only accepted for loopback or LAN hosts)")]
    Insecure(&'static str),
    #[error("{0} must be an origin, without path, query or credentials")]
    NotAnOrigin(&'static str),
    #[error("{0} must be https, or http on a loopback host")]
    InsecureUpdate(&'static str),
    #[error("{0} must be stable or beta")]
    UnknownChannel(&'static str),
}

/// `config.json` in the app config directory. Unknown fields are ignored.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileConfig {
    api_origin: Option<String>,
    public_console_url: Option<String>,
    update_url: Option<String>,
    update_channel: Option<String>,
    popup: Option<bool>,
}

/// The lab runs over plain http on a LAN or loopback host.
pub fn is_lab_host(host: &url::Host<&str>) -> bool {
    match host {
        url::Host::Domain(name) => {
            let name = name.to_ascii_lowercase();
            name == "localhost"
                || name.ends_with(".localhost")
                || name.ends_with(".local")
                || name.ends_with(".lan")
                || name.ends_with(".test")
        }
        url::Host::Ipv4(ip) => is_private_v4(ip),
        url::Host::Ipv6(ip) => ip.is_loopback(),
    }
}

fn is_private_v4(ip: &Ipv4Addr) -> bool {
    ip.is_loopback() || ip.is_private()
}

fn is_loopback(host: &url::Host<&str>) -> bool {
    match host {
        url::Host::Domain(name) => name.eq_ignore_ascii_case("localhost"),
        url::Host::Ipv4(ip) => ip.is_loopback(),
        url::Host::Ipv6(ip) => ip.is_loopback(),
    }
}

/// An exact origin, https or lab http. Anything with a path, a query, a
/// fragment or credentials is refused rather than silently trimmed: a
/// misconfiguration should be loud.
pub fn validate_origin(name: &'static str, raw: &str) -> Result<String, ConfigError> {
    let url = Url::parse(raw.trim()).map_err(|_| ConfigError::Invalid(name))?;
    let host = url.host().ok_or(ConfigError::Invalid(name))?;
    match url.scheme() {
        "https" => {}
        "http" if is_lab_host(&host) => {}
        "http" => return Err(ConfigError::Insecure(name)),
        _ => return Err(ConfigError::Invalid(name)),
    }
    let bare_path = url.path() == "/" || url.path().is_empty();
    if !bare_path || url.query().is_some() || url.fragment().is_some() || !url.username().is_empty() || url.password().is_some() {
        return Err(ConfigError::NotAnOrigin(name));
    }
    Ok(url.origin().ascii_serialization())
}

/// The update manifest URL: https, or http on loopback only (the local update
/// server of the prototype). The artifact is signed either way; transport
/// security still matters for the manifest's freshness.
pub fn validate_update_url(name: &'static str, raw: &str) -> Result<String, ConfigError> {
    let url = Url::parse(raw.trim()).map_err(|_| ConfigError::Invalid(name))?;
    let host = url.host().ok_or(ConfigError::Invalid(name))?;
    match url.scheme() {
        "https" => {}
        "http" if is_loopback(&host) => {}
        "http" => return Err(ConfigError::InsecureUpdate(name)),
        _ => return Err(ConfigError::Invalid(name)),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ConfigError::Invalid(name));
    }
    Ok(url.to_string())
}

/// Resolves the configuration from the environment and `config.json`.
/// `hosted_updates`: the production app, whose feed defaults to the hosted
/// one; the preview has no feed unless one is configured.
pub fn load(config_dir: Option<&Path>, env: &dyn Fn(&str) -> Option<String>, hosted_updates: bool) -> Result<ShellConfig, ConfigError> {
    let file = config_dir.map(|dir| read_file(&dir.join("config.json"))).unwrap_or_default();
    let pick = |var: &str, from_file: &Option<String>| -> Option<String> {
        env(var).filter(|value| !value.trim().is_empty()).or_else(|| from_file.clone().filter(|value| !value.trim().is_empty()))
    };
    let api_origin = validate_origin(
        "OPENEDBOT_API_ORIGIN",
        &pick("OPENEDBOT_API_ORIGIN", &file.api_origin).unwrap_or_else(|| PRODUCTION_API_ORIGIN.into()),
    )?;
    let public_console_url = validate_origin(
        "OPENEDBOT_PUBLIC_CONSOLE_URL",
        &pick("OPENEDBOT_PUBLIC_CONSOLE_URL", &file.public_console_url).unwrap_or_else(|| PRODUCTION_CONSOLE_URL.into()),
    )?;
    let channel = pick("OPENEDBOT_UPDATE_CHANNEL", &file.update_channel)
        .map(|raw| UpdateChannel::parse(&raw).ok_or(ConfigError::UnknownChannel("OPENEDBOT_UPDATE_CHANNEL")))
        .transpose()?
        .unwrap_or_default();
    // An explicit manifest (a local feed, a test) wins over the channel.
    let update_url = match pick("OPENEDBOT_UPDATE_URL", &file.update_url) {
        Some(raw) => Some(validate_update_url("OPENEDBOT_UPDATE_URL", &raw)?),
        None => hosted_updates.then(|| channel.manifest_url()),
    };
    let popup = match env("OPENEDBOT_POPUP").as_deref() {
        Some("1") | Some("true") => true,
        Some("0") | Some("false") => false,
        _ => file.popup.unwrap_or(true),
    };
    Ok(ShellConfig { api_origin, public_console_url, update_url, popup })
}

fn read_file(path: &Path) -> FileConfig {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|_| {
            log::warn!("config.json ignored (invalid JSON)");
            FileConfig::default()
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => FileConfig::default(),
        Err(_) => {
            log::warn!("config.json ignored (unreadable)");
            FileConfig::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_env(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn accepts_https_anywhere_and_http_on_lab_hosts_only() {
        assert_eq!(validate_origin("x", "https://api.openedbot.app").unwrap(), "https://api.openedbot.app");
        assert_eq!(validate_origin("x", "http://127.0.0.1:8790").unwrap(), "http://127.0.0.1:8790");
        assert_eq!(validate_origin("x", "http://localhost:8790/").unwrap(), "http://localhost:8790");
        assert_eq!(validate_origin("x", "http://192.168.1.240:8790").unwrap(), "http://192.168.1.240:8790");
        assert_eq!(validate_origin("x", "http://10.0.0.2").unwrap(), "http://10.0.0.2");
        assert_eq!(validate_origin("x", "http://172.16.0.1").unwrap(), "http://172.16.0.1");
        assert_eq!(validate_origin("x", "http://hermes.lan").unwrap(), "http://hermes.lan");
        assert_eq!(validate_origin("x", "http://[::1]:8790").unwrap(), "http://[::1]:8790");
    }

    #[test]
    fn refuses_http_on_public_hosts_and_odd_schemes() {
        assert_eq!(validate_origin("x", "http://api.openedbot.app"), Err(ConfigError::Insecure("x")));
        assert_eq!(validate_origin("x", "http://8.8.8.8"), Err(ConfigError::Insecure("x")));
        assert_eq!(validate_origin("x", "http://172.32.0.1"), Err(ConfigError::Insecure("x")));
        assert_eq!(validate_origin("x", "http://localhost.evil.com"), Err(ConfigError::Insecure("x")));
        assert_eq!(validate_origin("x", "file:///etc/passwd"), Err(ConfigError::Invalid("x")));
        assert_eq!(validate_origin("x", "tauri://localhost"), Err(ConfigError::Invalid("x")));
        assert_eq!(validate_origin("x", "not a url"), Err(ConfigError::Invalid("x")));
    }

    #[test]
    fn refuses_anything_but_a_bare_origin() {
        assert_eq!(validate_origin("x", "https://api.openedbot.app/api"), Err(ConfigError::NotAnOrigin("x")));
        assert_eq!(validate_origin("x", "https://api.openedbot.app/?a=1"), Err(ConfigError::NotAnOrigin("x")));
        assert_eq!(validate_origin("x", "https://user:pw@api.openedbot.app"), Err(ConfigError::NotAnOrigin("x")));
    }

    #[test]
    fn update_url_allows_http_on_loopback_only() {
        assert!(validate_update_url("u", "http://127.0.0.1:8799/latest.json").is_ok());
        assert!(validate_update_url("u", "https://updates.openedbot.app/stable/latest.json").is_ok());
        assert_eq!(validate_update_url("u", "http://192.168.1.2/latest.json"), Err(ConfigError::InsecureUpdate("u")));
    }

    #[test]
    fn defaults_to_production_and_lets_the_environment_win_over_the_file() {
        let defaults = load(None, &no_env, false).unwrap();
        assert_eq!(defaults.api_origin, PRODUCTION_API_ORIGIN);
        assert_eq!(defaults.public_console_url, PRODUCTION_CONSOLE_URL);
        assert_eq!(defaults.update_url, None);
        // The notch is on unless turned off: the user chooses at the first sign-in.
        assert!(defaults.popup);

        let dir = std::env::temp_dir().join(format!("openedbot-config-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config.json"), r#"{"apiOrigin":"http://127.0.0.1:8790","popup":false}"#).unwrap();
        let from_file = load(Some(&dir), &no_env, false).unwrap();
        assert_eq!(from_file.api_origin, "http://127.0.0.1:8790");
        assert!(!from_file.popup, "the kill switch in config.json");
        let on = |name: &str| (name == "OPENEDBOT_POPUP").then(|| "1".to_string());
        assert!(load(Some(&dir), &on, false).unwrap().popup, "the environment wins over the file");
        let off = |name: &str| (name == "OPENEDBOT_POPUP").then(|| "0".to_string());
        assert!(!load(None, &off, false).unwrap().popup, "the kill switch in the environment");
        let env = |name: &str| (name == "OPENEDBOT_API_ORIGIN").then(|| "http://localhost:9000".to_string());
        assert_eq!(load(Some(&dir), &env, false).unwrap().api_origin, "http://localhost:9000");
        std::fs::write(dir.join("config.json"), r#"{"apiOrigin":"http://example.com"}"#).unwrap();
        assert_eq!(load(Some(&dir), &no_env, false), Err(ConfigError::Insecure("OPENEDBOT_API_ORIGIN")));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_production_app_follows_its_channel_on_the_hosted_feed() {
        assert_eq!(load(None, &no_env, true).unwrap().update_url.as_deref(), Some("https://releases.openedbot.app/desktop/solo/stable/latest.json"));
        let beta = |name: &str| (name == "OPENEDBOT_UPDATE_CHANNEL").then(|| "beta".to_string());
        assert_eq!(load(None, &beta, true).unwrap().update_url.as_deref(), Some("https://releases.openedbot.app/desktop/solo/beta/latest.json"));
        // The preview has no hosted feed, whatever the channel.
        assert_eq!(load(None, &beta, false).unwrap().update_url, None);
        let odd = |name: &str| (name == "OPENEDBOT_UPDATE_CHANNEL").then(|| "nightly".to_string());
        assert_eq!(load(None, &odd, true), Err(ConfigError::UnknownChannel("OPENEDBOT_UPDATE_CHANNEL")));
        // A local feed wins over the channel (the update tests).
        let local = |name: &str| match name {
            "OPENEDBOT_UPDATE_URL" => Some("http://127.0.0.1:8799/latest.json".to_string()),
            "OPENEDBOT_UPDATE_CHANNEL" => Some("beta".to_string()),
            _ => None,
        };
        assert_eq!(load(None, &local, true).unwrap().update_url.as_deref(), Some("http://127.0.0.1:8799/latest.json"));
    }
}
