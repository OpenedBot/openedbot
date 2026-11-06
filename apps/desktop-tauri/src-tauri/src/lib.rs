//! openedbot desktop, Tauri 2 prototype (ADR 0001, step D2a).
//!
//! One window serves the console embedded in the app (`../console-dist`, the
//! solo desktop build) from the local origin (`tauri://localhost` on macOS).
//! The session lives here (`auth.rs`, bearer, Keychain); the console reaches
//! it through the typed bridge (`bridge.rs`) only. The notch popup is hosted
//! over its stdin/stdout protocol (`popup.rs`), and the app updates itself
//! from a signed feed (`updater.rs`).
//!
//! The prototype coexists with the Electron app: its own bundle identifier
//! (Keychain service), its own name, no `openedbot://` scheme.

pub mod auth;
pub mod bridge;
pub mod config;
pub mod csp;
mod logger;
pub mod popup;
mod updater;
pub mod vault;

use std::borrow::Cow;
use std::sync::Arc;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri_specta::Event;
use url::Url;

use auth::{AuthApi, AuthEvents, AuthService, HttpAuthApi, SignedOutReason, SigninState};
use bridge::{Auth, Shell, SigninStateChanged};
use config::ShellConfig;
use popup::{GiveUp, HostToPopup, PopupEvents, PopupHost, TokenSource};
use vault::{KeychainVault, Vault, VaultError};

pub const BUNDLE_ID: &str = "app.openedbot.desktop.preview";
/// The OAuth client id the API records for this build.
pub const CLIENT_ID: &str = "openedbot-desktop-macos-preview";
/// A redirect URI the API allows (`nativeRedirectUris`, `platform/config/src/api-config.ts`).
/// The e-mail code door never opens it: it only binds the authorization code to this client.
pub const REDIRECT_URI: &str = "http://127.0.0.1:47813/callback";
pub const MAIN_WINDOW: &str = "main";
/// The console route the window shows, as in the Electron shell (`window.ts`):
/// the compact frame primes its session from the bridge (`compact-shell.ts`);
/// the full console does not yet (D2b).
pub const START_PATH: &str = "/compact";

/// A keystore turned off (`OPENEDBOT_PREVIEW_VAULT=memory`, development runs
/// whose ad hoc signature changes on every build): memory-only sessions.
struct DisabledVault;

impl Vault for DisabledVault {
    fn load(&self) -> Result<Option<String>, VaultError> {
        Err(VaultError("disabled".into()))
    }
    fn save(&self, _: &str) -> Result<(), VaultError> {
        Err(VaultError("disabled".into()))
    }
    fn clear(&self) -> Result<(), VaultError> {
        Ok(())
    }
}

impl<A: AuthApi, V: Vault> TokenSource for AuthService<A, V> {
    async fn read_access(&self, force: bool, served: Option<String>) -> Result<Option<auth::AccessGrant>, auth::ApiError> {
        AuthService::read_access(self, force, served).await
    }
    fn is_signed_in(&self) -> bool {
        AuthService::is_signed_in(self)
    }
    async fn sign_out(&self) {
        AuthService::sign_out(self).await;
    }
}

struct PopupHandle(Arc<PopupHost<Auth>>);

/// Shows a path of the local console in the main window.
fn navigate<R: Runtime>(app: &AppHandle<R>, path_and_query: &str) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else { return };
    let Ok(current) = window.url() else { return };
    let Ok(target) = current.join(path_and_query) else { return };
    // `Url::origin` is opaque for `tauri:` (not a special scheme): compare the parts.
    let same = |url: &Url| (url.scheme().to_string(), url.host_str().map(str::to_string), url.port());
    if same(&target) != same(&current) || !is_local_origin(&target) {
        log::warn!("navigation outside the local origin refused");
        return;
    }
    let _ = window.navigate(target);
    let _ = window.show();
    let _ = window.set_focus();
}

struct ShellEvents<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> ShellEvents<R> {
    fn popup(&self, message: HostToPopup) {
        if let Some(popup) = self.app.try_state::<PopupHandle>() {
            popup.0.notify(message);
        }
    }
}

impl<R: Runtime> AuthEvents for ShellEvents<R> {
    fn signin_state(&self, state: &SigninState) {
        if let Err(error) = SigninStateChanged(state.clone()).emit(&self.app) {
            log::warn!("sign-in state not delivered ({error})");
        }
    }

    fn signed_in(&self) {
        log::info!("signed in");
        navigate(&self.app, START_PATH);
        self.popup(HostToPopup::SignedIn);
    }

    fn signed_out(&self, reason: SignedOutReason) {
        log::info!("signed out ({reason:?})");
        navigate(&self.app, if reason == SignedOutReason::SessionLost { "/login?reason=session-lost" } else { "/login" });
        self.popup(HostToPopup::SignedOut);
    }
}

struct ShellPopupEvents<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> PopupEvents for ShellPopupEvents<R> {
    fn open_console(&self, path: &str) {
        navigate(&self.app, path);
    }
    fn gave_up(&self, reason: &GiveUp) {
        // The window stays the way in; D2b adds the dialog of the Electron shell.
        log::warn!("popup unavailable ({reason:?}), the window remains");
    }
}

/// The values the console reads before its first module runs.
pub fn initialization_script(config: &ShellConfig, version: &str) -> String {
    let shell = serde_json::json!({
        "platform": std::env::consts::OS,
        "version": version,
        "bridgeVersion": bridge::BRIDGE_VERSION,
    });
    format!(
        "Object.defineProperty(window, '__OPENEDBOT_SHELL__', {{ value: Object.freeze({shell}), writable: false, configurable: false }});\n\
         window.__OPENEDBOT_API_ORIGIN__ = {api};\n\
         window.__OPENEDBOT_PUBLIC_CONSOLE_URL__ = {console};\n",
        api = serde_json::Value::String(config.api_origin.clone()),
        console = serde_json::Value::String(config.public_console_url.clone()),
    )
}

fn is_local_origin(url: &Url) -> bool {
    matches!((url.scheme(), url.host_str()), ("tauri", Some("localhost")) | ("http", Some("tauri.localhost")) | ("https", Some("tauri.localhost")))
}

/// The main window: the embedded console, navigation locked on the local
/// origin, new windows sent to the system browser when trusted, the CSP
/// completed with the runtime API origin.
pub fn main_window<R: Runtime, M: Manager<R>>(manager: &M, config: &ShellConfig, version: &str, signed_in: bool) -> tauri::Result<tauri::WebviewWindow<R>> {
    // Signed out, the console's own `/login` (driven through the bridge).
    let start = if signed_in { START_PATH } else { "/login" };
    let api_origin = config.api_origin.clone();
    let popup_config = config.clone();
    let app = manager.app_handle().clone();
    WebviewWindowBuilder::new(manager, MAIN_WINDOW, WebviewUrl::App(start.trim_start_matches('/').into()))
        .title("openedbot preview")
        .inner_size(1100.0, 760.0)
        .min_inner_size(420.0, 520.0)
        .initialization_script(initialization_script(config, version))
        .on_web_resource_request(move |_request, response| {
            let html = response
                .headers()
                .get("content-type")
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| value.starts_with("text/html"));
            if !html {
                return;
            }
            if let Some(filled) = csp::fill(response.body(), &api_origin) {
                *response.body_mut() = Cow::Owned(filled);
            }
        })
        .on_navigation(|url| {
            let allowed = is_local_origin(url);
            if !allowed {
                log::warn!("navigation to another origin refused ({})", url.scheme());
            }
            allowed
        })
        .on_new_window(move |url, _features| {
            match bridge::trusted_external_url(&popup_config, url.as_str()) {
                Ok(url) => {
                    use tauri_plugin_opener::OpenerExt;
                    if app.opener().open_url(url.as_str(), None::<&str>).is_err() {
                        log::warn!("system browser could not be opened");
                    }
                }
                Err(_) => log::warn!("new window to an untrusted origin refused"),
            }
            NewWindowResponse::Deny
        })
        .build()
}

fn setup<R: Runtime>(app: &mut tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    if let Ok(dir) = app.path().app_log_dir() {
        logger::init(dir);
    }
    let version = app.package_info().version.to_string();
    let env = |name: &str| std::env::var(name).ok();
    let config = config::load(app.path().app_config_dir().ok().as_deref(), &env).inspect_err(|error| log::error!("configuration refused: {error}"))?;
    log::info!("openedbot preview {version}, API {}", config.api_origin);

    let vault: Box<dyn Vault> = if std::env::var("OPENEDBOT_PREVIEW_VAULT").as_deref() == Ok("memory") {
        Box::new(DisabledVault)
    } else {
        Box::new(KeychainVault::new(BUNDLE_ID, &config.api_origin))
    };
    let events: Arc<dyn AuthEvents> = Arc::new(ShellEvents { app: handle.clone() });
    let auth = Arc::new(AuthService::new(HttpAuthApi::new(&config.api_origin, &version), vault, events, REDIRECT_URI, CLIENT_ID));
    let restored = auth.restore();
    log::info!("session {} ({:?})", if restored { "restored" } else { "absent" }, auth.persistence());

    let opener_handle = handle.clone();
    app.manage(Shell {
        auth: auth.clone(),
        config: config.clone(),
        version: version.clone(),
        opener: Box::new(move |url: &Url| {
            use tauri_plugin_opener::OpenerExt;
            opener_handle.opener().open_url(url.as_str(), None::<&str>).map_err(|error| error.to_string())
        }),
    });
    main_window(app, &config, &version, restored)?;

    if config.popup {
        let executable = std::env::current_exe()?;
        let bundle = popup::locate_bundle(&executable, std::env::var_os("OPENEDBOT_POPUP_APP").map(Into::into));
        let host = PopupHost::new(bundle, &config.api_origin, &config.public_console_url, auth, Arc::new(ShellPopupEvents { app: handle.clone() }));
        host.start();
        app.manage(PopupHandle(host));
    }
    if let Some(manifest) = config.update_url.clone() {
        let (stop_handle, restart_handle) = (handle.clone(), handle.clone());
        let hooks = updater::InstallHooks {
            before_install: Box::new(move || {
                if let Some(popup) = stop_handle.try_state::<PopupHandle>() {
                    log::info!("stopping the popup before the update replaces the bundle");
                    popup.0.stop();
                }
            }),
            after_failed_install: Box::new(move || {
                if let Some(popup) = restart_handle.try_state::<PopupHandle>() {
                    log::info!("update not installed: restarting the popup");
                    popup.0.start();
                }
            }),
        };
        updater::spawn_check(handle, manifest, hooks);
    }
    Ok(())
}

pub fn run() {
    let specta = bridge::specta_builder::<tauri::Wry>();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(specta.invoke_handler())
        .setup(move |app| {
            specta.mount_events(app);
            setup(app)
        })
        .build(tauri::generate_context!())
        .expect("openedbot preview failed to start");
    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(popup) = handle.try_state::<PopupHandle>() {
                popup.0.stop();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
    use tauri::webview::InvokeRequest;

    fn test_config() -> ShellConfig {
        ShellConfig {
            // Never reached: the tests only call commands that answer locally.
            api_origin: "http://127.0.0.1:9".into(),
            public_console_url: "https://console.openedbot.app".into(),
            update_url: None,
            popup: false,
        }
    }

    struct NoEvents;
    impl AuthEvents for NoEvents {
        fn signin_state(&self, _: &SigninState) {}
        fn signed_in(&self) {}
        fn signed_out(&self, _: SignedOutReason) {}
    }

    fn app() -> tauri::App<MockRuntime> {
        let specta = bridge::specta_builder::<MockRuntime>();
        let app = mock_builder()
            .invoke_handler(specta.invoke_handler())
            .build(tauri::generate_context!(test = true))
            .expect("mock app");
        let config = test_config();
        let auth = AuthService::new(HttpAuthApi::new(&config.api_origin, "0.0.0"), Box::new(DisabledVault) as Box<dyn Vault>, Arc::new(NoEvents), REDIRECT_URI, CLIENT_ID);
        auth.restore();
        app.manage(Shell { auth: Arc::new(auth), config, version: "0.0.0".into(), opener: Box::new(|_| Ok(())) });
        app
    }

    fn window(app: &tauri::App<MockRuntime>, label: &str) -> tauri::WebviewWindow<MockRuntime> {
        WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into())).build().expect("window")
    }

    fn invoke(window: &tauri::WebviewWindow<MockRuntime>, cmd: &str, origin: &str, body: Value) -> Result<Value, Value> {
        get_ipc_response(
            window,
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: origin.parse().unwrap(),
                body: InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|response| response.deserialize::<Value>().unwrap())
    }

    const LOCAL: &str = "tauri://localhost";

    #[test]
    fn the_main_window_on_the_local_origin_reaches_the_bridge() {
        let app = app();
        let main = window(&app, MAIN_WINDOW);
        assert_eq!(invoke(&main, "read_access_token", LOCAL, json!({})), Ok(Value::Null));
        let info = invoke(&main, "shell_info", LOCAL, json!({})).unwrap();
        assert_eq!(info["bridgeVersion"], json!(bridge::BRIDGE_VERSION));
        assert_eq!(info["persistence"], json!("memory-only"));
        assert_eq!(invoke(&main, "signin_state", LOCAL, json!({})), Ok(json!({ "status": "idle" })));
    }

    #[test]
    fn another_window_is_refused() {
        let app = app();
        let _main = window(&app, MAIN_WINDOW);
        let probe = window(&app, "probe");
        for command in bridge::COMMANDS {
            let refused = invoke(&probe, command, LOCAL, json!({})).expect_err(command);
            assert!(refused.to_string().contains("not allowed"), "{command}: {refused}");
        }
    }

    #[test]
    fn another_origin_is_refused_even_in_the_main_window() {
        let app = app();
        let main = window(&app, MAIN_WINDOW);
        for origin in ["https://console.openedbot.app", "http://localhost:1420", "https://evil.example"] {
            let refused = invoke(&main, "read_access_token", origin, json!({})).expect_err(origin);
            assert!(refused.to_string().contains("not allowed"), "{origin}: {refused}");
        }
    }

    #[test]
    fn plugin_commands_are_not_granted_to_the_page() {
        let app = app();
        let main = window(&app, MAIN_WINDOW);
        for command in ["plugin:opener|open_url", "plugin:updater|check", "plugin:updater|download_and_install", "plugin:webview|create_webview_window"] {
            let refused = invoke(&main, command, LOCAL, json!({ "url": "https://evil.example" })).expect_err(command);
            assert!(refused.to_string().contains("not allowed") || refused.to_string().contains("not found"), "{command}: {refused}");
        }
    }

    #[test]
    fn open_external_only_takes_the_console_and_the_api() {
        let config = test_config();
        assert!(bridge::trusted_external_url(&config, "https://console.openedbot.app/o/acme").is_ok());
        assert!(bridge::trusted_external_url(&config, "http://127.0.0.1:9/api/legal").is_ok());
        for refused in ["https://evil.example", "file:///etc/passwd", "javascript:alert(1)", "https://console.openedbot.app.evil.example/"] {
            assert!(bridge::trusted_external_url(&config, refused).is_err(), "{refused}");
        }
    }

    #[test]
    fn the_capability_grants_exactly_the_declared_commands() {
        let capability: Value = serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        assert_eq!(capability["windows"], json!([MAIN_WINDOW]));
        assert!(capability.get("remote").is_none(), "no remote origin may reach the bridge");
        let mut granted: Vec<String> = capability["permissions"].as_array().unwrap().iter().map(|value| value.as_str().unwrap().to_string()).collect();
        let mut expected: Vec<String> = bridge::COMMANDS.iter().map(|name| format!("allow-{}", name.replace('_', "-"))).collect();
        expected.extend(["core:event:allow-listen".to_string(), "core:event:allow-unlisten".to_string()]);
        granted.sort();
        expected.sort();
        assert_eq!(granted, expected);
    }

    #[test]
    fn bindings_are_current() {
        let committed = include_str!("../../../../contracts/native-bridge/src/bindings.ts");
        assert_eq!(bridge::bindings_typescript(), committed, "run `make desktop-tauri-bindings`");
    }

    #[test]
    fn the_initialization_script_escapes_its_values() {
        let script = initialization_script(&test_config(), "0.0.1");
        assert!(script.contains(r#"window.__OPENEDBOT_API_ORIGIN__ = "http://127.0.0.1:9";"#));
        assert!(script.contains(r#""version":"0.0.1""#));
    }
}
