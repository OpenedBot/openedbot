//! Which app this build is (ADR 0001, D3): the preview, which coexists with
//! the Electron app, or the production app that replaces it.
//!
//! The identity is the bundle configuration compiled into the binary
//! (`tauri.conf.json`, plus `tauri.production.conf.json` for a release built
//! by `scripts/build-mac.ts --identity production`), never a second constant
//! that could drift from it:
//!
//! | | preview | production |
//! |---|---|---|
//! | identifier (Keychain service, data directories) | `app.openedbot.desktop.preview` | `app.openedbot.desktop`, as Electron (`apps/desktop/electron-builder.yml`) |
//! | name | « openedbot preview » | « openedbot » |
//! | `openedbot://` | never declared | declared |
//! | update feed by default | none | `config::PRODUCTION_UPDATE_BASE` |
//!
//! The Electron app keeps its session in `~/Library/Application Support/openedbot`
//! (`safeStorage`, Keychain item « openedbot Safe Storage »): nothing here ever
//! reads it, so the switch signs the user in once (Q1) and the two apps never
//! share a refresh token.

pub const PRODUCTION_BUNDLE_ID: &str = "app.openedbot.desktop";
/// The scheme the production app answers (Google's return, as Electron).
pub const SCHEME: &str = crate::callback::SCHEME;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    /// The bundle identifier: the Keychain service of the session too.
    pub bundle_id: String,
    /// The name shown in menus and dialogs.
    pub product: String,
    /// The OAuth client id the API records for this build.
    pub client_id: String,
    /// The production app: default update feed, `openedbot://`.
    pub production: bool,
    /// The bundle declares `openedbot://` (macOS reads it from Info.plist).
    pub declares_scheme: bool,
}

impl Identity {
    pub fn new(bundle_id: &str, product: &str, declared_schemes: &[String]) -> Self {
        let production = bundle_id == PRODUCTION_BUNDLE_ID;
        let suffix = if production { "" } else { "-preview" };
        Self {
            bundle_id: bundle_id.to_string(),
            product: product.to_string(),
            client_id: format!("openedbot-desktop-{}{suffix}", os_name()),
            production,
            declares_scheme: declared_schemes.iter().any(|scheme| scheme == SCHEME),
        }
    }

    /// From the configuration compiled into the app.
    pub fn from_config(config: &tauri::Config, product: &str) -> Self {
        Self::new(&config.identifier, product, &declared_schemes(&config.plugins.0))
    }

    /// The shell's log file: `preview.log` for the preview (what the Linux
    /// end-to-end run reads), `openedbot.log` for the production app.
    pub fn log_file(&self) -> &'static str {
        if self.production {
            "openedbot.log"
        } else {
            "preview.log"
        }
    }
}

fn os_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

/// `plugins.deep-link.desktop.schemes` of the bundle configuration.
pub fn declared_schemes(plugins: &std::collections::HashMap<String, serde_json::Value>) -> Vec<String> {
    plugins
        .get("deep-link")
        .and_then(|deep_link| deep_link.get("desktop"))
        .and_then(|desktop| desktop.get("schemes"))
        .and_then(|schemes| schemes.as_array())
        .map(|list| list.iter().filter_map(|value| value.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(text: &str) -> serde_json::Value {
        serde_json::from_str(text).unwrap()
    }

    fn plugins(config: &serde_json::Value) -> std::collections::HashMap<String, serde_json::Value> {
        config["plugins"].as_object().map(|map| map.clone().into_iter().collect()).unwrap_or_default()
    }

    #[test]
    fn the_committed_configuration_is_the_preview() {
        let base = json(include_str!("../tauri.conf.json"));
        let identity = Identity::new(base["identifier"].as_str().unwrap(), base["productName"].as_str().unwrap(), &declared_schemes(&plugins(&base)));
        assert_eq!(identity.bundle_id, "app.openedbot.desktop.preview");
        assert_eq!(identity.product, "openedbot preview");
        assert!(!identity.production);
        // The preview never claims the scheme of the installed Electron app.
        assert!(!identity.declares_scheme);
        assert!(identity.client_id.ends_with("-preview"));
        assert_eq!(identity.log_file(), "preview.log");
    }

    #[test]
    fn the_production_overlay_takes_over_the_electron_identity() {
        let overlay = json(include_str!("../tauri.production.conf.json"));
        let identity = Identity::new(overlay["identifier"].as_str().unwrap(), overlay["productName"].as_str().unwrap(), &declared_schemes(&plugins(&overlay)));
        assert_eq!(identity.bundle_id, PRODUCTION_BUNDLE_ID);
        assert_eq!(identity.product, "openedbot");
        assert!(identity.production);
        assert!(identity.declares_scheme);
        assert_eq!(identity.client_id, format!("openedbot-desktop-{}", os_name()));
        assert_eq!(overlay["mainBinaryName"], "openedbot");
        // Same bundle identifier and name as the Electron app it replaces.
        let electron = include_str!("../../../desktop/electron-builder.yml");
        assert!(electron.lines().any(|line| line.trim() == format!("appId: {PRODUCTION_BUNDLE_ID}")));
        assert!(electron.lines().any(|line| line.trim() == "productName: openedbot"));
    }

    #[test]
    fn the_linux_preview_keeps_its_own_scheme() {
        let linux = json(include_str!("../tauri.linux.conf.json"));
        assert_eq!(declared_schemes(&plugins(&linux)), vec!["openedbot-preview".to_string()]);
        assert!(!Identity::new("app.openedbot.desktop.preview", "openedbot preview", &declared_schemes(&plugins(&linux))).declares_scheme);
    }
}
