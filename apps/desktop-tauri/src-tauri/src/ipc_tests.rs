//! The IPC boundary (ADR 0001, 4.3 "Sécurité IPC"): only the main window, on
//! the local origin, reaches the bridge; plugin commands stay closed but the
//! three the notification polyfill needs.

use super::*;
use auth::{SignedOutReason, SigninState};
use config::ShellConfig;
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

struct NoWindow;
impl bridge::WindowControl for NoWindow {
    fn set_theme(&self, _: window::ThemeMode) {}
    fn set_text_zoom(&self, _: f64) {}
    fn start_drag(&self) {}
    fn toggle_maximize(&self) {}
}

struct NoBrowser;
impl auth::GoogleSteps for NoBrowser {
    fn start_loopback(&self, _: u64) -> Result<(), auth::StepFailed> {
        Err(auth::StepFailed)
    }
    fn stop_loopback(&self, _: u64) {}
    fn open_browser(&self, _: &Url) -> Result<(), auth::StepFailed> {
        Err(auth::StepFailed)
    }
}

fn app() -> tauri::App<MockRuntime> {
    let specta = bridge::specta_builder::<MockRuntime>();
    let app = mock_builder()
        .invoke_handler(specta.invoke_handler())
        .build(tauri::generate_context!(test = true))
        .expect("mock app");
    let config = test_config();
    let auth = AuthService::new(HttpAuthApi::new(&config.api_origin, "0.0.0"), Box::new(DisabledVault) as Box<dyn Vault>, Arc::new(NoEvents), callback::LOOPBACK_REDIRECT_URI, CLIENT_ID);
    auth.restore();
    app.manage(Shell { auth: Arc::new(auth), config, version: "0.0.0".into(), opener: Box::new(|_| Ok(())), google: Arc::new(NoBrowser), client_id: CLIENT_ID.into(), window: Box::new(NoWindow) });
    let status = Arc::new(crate::update_state::UpdateStatus::new(true, Box::new(|_, _| {})));
    app.manage(status.clone());
    app.manage(bridge::Updates(Arc::new(crate::update_engine::NoUpdates(status))));
    app.manage(WindowState::new(Arc::new(prefs::PreferenceStore::open(None))));
    app
}

fn window(app: &tauri::App<MockRuntime>, label: &str) -> tauri::WebviewWindow<MockRuntime> {
    tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App("index.html".into())).build().expect("window")
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
    let main = window(&app, window::MAIN_WINDOW);
    assert_eq!(invoke(&main, "read_access_token", LOCAL, json!({})), Ok(Value::Null));
    let info = invoke(&main, "shell_info", LOCAL, json!({})).unwrap();
    assert_eq!(info["bridgeVersion"], json!(bridge::BRIDGE_VERSION));
    assert_eq!(info["persistence"], json!("memory-only"));
    assert_eq!(info["platform"], json!(bridge::Platform::current().as_str()));
    assert_eq!(invoke(&main, "signin_state", LOCAL, json!({})), Ok(json!({ "status": "idle" })));
}

#[test]
fn another_window_is_refused() {
    let app = app();
    let _main = window(&app, window::MAIN_WINDOW);
    let probe = window(&app, "probe");
    for command in bridge::COMMANDS {
        let refused = invoke(&probe, command, LOCAL, json!({})).expect_err(command);
        assert!(refused.to_string().contains("not allowed"), "{command}: {refused}");
    }
}

#[test]
fn another_origin_is_refused_even_in_the_main_window() {
    let app = app();
    let main = window(&app, window::MAIN_WINDOW);
    for origin in ["https://console.openedbot.app", "http://localhost:1420", "https://evil.example"] {
        let refused = invoke(&main, "read_access_token", origin, json!({})).expect_err(origin);
        assert!(refused.to_string().contains("not allowed"), "{origin}: {refused}");
    }
}

#[test]
fn plugin_commands_are_not_granted_to_the_page() {
    let app = app();
    let main = window(&app, window::MAIN_WINDOW);
    for command in [
        "plugin:opener|open_url",
        "plugin:updater|check",
        "plugin:updater|download_and_install",
        "plugin:webview|create_webview_window",
        "plugin:window|start_dragging",
        "plugin:deep-link|register",
        "plugin:dialog|open",
        "plugin:global-shortcut|register",
        "plugin:notification|register_listener",
        "plugin:fs|read_file",
    ] {
        let refused = invoke(&main, command, LOCAL, json!({ "url": "https://evil.example" })).expect_err(command);
        assert!(refused.to_string().contains("not allowed") || refused.to_string().contains("not found"), "{command}: {refused}");
    }
}

#[test]
fn open_external_only_takes_the_console_and_the_api() {
    let config = test_config();
    assert!(bridge::trusted_external_url(&config, "https://console.openedbot.app/o/acme").is_ok());
    assert!(bridge::trusted_external_url(&config, "http://127.0.0.1:9/api/legal").is_ok());
    assert!(bridge::trusted_external_url(&config, "https://openedbot.app/fr/download").is_ok());
    for refused in [
        "https://evil.example",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "https://console.openedbot.app.evil.example/",
        "https://openedbot.app/blog",
        "http://openedbot.app/download",
        "https://openedbot.app/download?next=https://evil.example",
    ] {
        assert!(bridge::trusted_external_url(&config, refused).is_err(), "{refused}");
    }
}

#[test]
fn the_capability_grants_exactly_the_declared_commands() {
    let capability: Value = serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
    assert_eq!(capability["windows"], json!([window::MAIN_WINDOW]));
    assert!(capability.get("remote").is_none(), "no remote origin may reach the bridge");
    let mut granted: Vec<String> = capability["permissions"].as_array().unwrap().iter().map(|value| value.as_str().unwrap().to_string()).collect();
    let mut expected: Vec<String> = bridge::COMMANDS.iter().map(|name| format!("allow-{}", name.replace('_', "-"))).collect();
    expected.extend(
        ["core:event:allow-listen", "core:event:allow-unlisten", "notification:allow-is-permission-granted", "notification:allow-request-permission", "notification:allow-notify"]
            .map(str::to_string),
    );
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
fn a_diagnostic_from_the_page_cannot_speak_as_the_shell() {
    let app = app();
    let main = window(&app, window::MAIN_WINDOW);
    let page = json!({ "level": "error", "source": "page", "message": "TypeError: x is undefined", "detail": null });
    assert_eq!(invoke(&main, "report_diagnostic", LOCAL, page), Ok(Value::Null));
    for source in ["main", "renderer"] {
        let forged = json!({ "level": "error", "source": source, "message": "forged", "detail": null });
        assert!(invoke(&main, "report_diagnostic", LOCAL, forged).is_err(), "{source}");
    }
    let huge = json!({ "level": "warn", "source": "http", "message": "x".repeat(5000), "detail": null });
    assert!(invoke(&main, "report_diagnostic", LOCAL, huge).is_err());
}

#[test]
fn an_unknown_text_zoom_is_refused() {
    let app = app();
    let main = window(&app, window::MAIN_WINDOW);
    let refused = invoke(&main, "set_text_zoom", LOCAL, json!({ "factor": 7.5 })).expect_err("zoom 7.5");
    assert!(refused.to_string().contains("INVALID_ZOOM"), "{refused}");
}

#[test]
fn the_update_state_is_readable_and_its_actions_are_checked() {
    let app = app();
    let main = window(&app, window::MAIN_WINDOW);
    let idle = json!({ "phase": { "status": "idle" }, "required": null, "lastError": null, "autoInstall": true, "lastCheck": null });
    assert_eq!(invoke(&main, "update_state", LOCAL, json!({})), Ok(idle));
    let refused = invoke(&main, "install_update", LOCAL, json!({ "version": "1.1.0" })).expect_err("nothing downloaded");
    assert!(refused.to_string().contains("UPDATE_NOT_READY"), "{refused}");
    // A prerelease offered by the feed (D5's 1.1.1-test) is a version: refused only because nothing is ready.
    let refused = invoke(&main, "install_update", LOCAL, json!({ "version": "1.1.1-test" })).expect_err("nothing downloaded");
    assert!(refused.to_string().contains("UPDATE_NOT_READY"), "{refused}");
    for forged in ["../1", "1.1", "v1.1.0", "1.1.0; rm", "1.1.0+build", ""] {
        let refused = invoke(&main, "install_update", LOCAL, json!({ "version": forged })).expect_err(forged);
        assert!(refused.to_string().contains("INVALID_VERSION"), "{forged}: {refused}");
    }
    for forged in ["1.1.0; rm", "../1", "v1.1.0", "1.1.0.0", ""] {
        let refused = invoke(&main, "report_update_required", LOCAL, json!({ "minimum": forged })).expect_err(forged);
        assert!(refused.to_string().contains("INVALID_VERSION"), "{forged}: {refused}");
    }
    assert_eq!(invoke(&main, "report_update_required", LOCAL, json!({ "minimum": "1.1.0" })), Ok(Value::Null));
    let state = invoke(&main, "update_state", LOCAL, json!({})).unwrap();
    assert_eq!(state["required"], json!({ "reason": "api", "minimum": "1.1.0" }));
    assert_eq!(invoke(&main, "check_for_updates", LOCAL, json!({})), Ok(Value::Null));
}

#[test]
fn the_runs_and_the_idle_setting_reach_the_shell() {
    let app = app();
    let main = window(&app, window::MAIN_WINDOW);
    assert_eq!(invoke(&main, "report_runs_in_progress", LOCAL, json!({ "count": 2 })), Ok(Value::Null));
    assert_eq!(app.state::<Arc<crate::update_state::UpdateStatus>>().runs(), Some(2));
    assert!(invoke(&main, "report_runs_in_progress", LOCAL, json!({ "count": 99_999 })).is_err());
    assert!(invoke(&main, "report_runs_in_progress", LOCAL, json!({ "count": -1 })).is_err());
    assert_eq!(invoke(&main, "report_runs_in_progress", LOCAL, json!({ "count": null })), Ok(Value::Null));
    assert_eq!(app.state::<Arc<crate::update_state::UpdateStatus>>().runs(), None, "unknown is not zero");
    assert_eq!(invoke(&main, "set_update_auto_install", LOCAL, json!({ "enabled": false })), Ok(Value::Null));
    assert_eq!(invoke(&main, "update_state", LOCAL, json!({})).unwrap()["autoInstall"], json!(false));
    assert!(!app.state::<WindowState>().prefs.get().auto_install_updates, "kept in the preferences");
}
