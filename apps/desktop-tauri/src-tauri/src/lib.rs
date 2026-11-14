//! openedbot desktop, Tauri 2.
//!
//! One window serves the console embedded in the app (`../console-dist`, the
//! solo desktop build) from the local origin (`tauri://localhost` on macOS,
//! `window.rs`). The session lives here (`auth.rs`, bearer, Keychain); the
//! console reaches it through the typed bridge (`bridge.rs`) only. The notch
//! popup is hosted over its stdin/stdout protocol (`popup.rs`), the app
//! updates itself from a signed feed (`updater.rs`, `update_engine.rs`,
//! `update_idle.rs`), with the user's consent, and `shell.rs` ties
//! session, window, popup and menus together.
//!
//! Which app it is comes from the bundle configuration (`identity.rs`): the
//! preview coexists with the production app (its own bundle identifier and
//! Keychain service, its own name, no `openedbot://` scheme); the production
//! build (D3) is `app.openedbot.desktop`, « openedbot », `openedbot://`.

pub mod auth;
pub mod bridge;
pub mod callback;
pub mod config;
pub mod csp;
pub mod diagnostics;
pub mod identity;
pub mod notch;
#[cfg(target_os = "linux")]
mod linux;
mod logger;
#[cfg(target_os = "macos")]
mod macos;
pub mod popup;
pub mod prefs;
pub mod shell;
pub mod update_engine;
pub mod update_idle;
pub mod update_state;
mod updater;
pub mod vault;
pub mod window;

use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Manager, Runtime};
use url::Url;

use auth::{AuthApi, AuthEvents, AuthService, HttpAuthApi};
use bridge::{Auth, Shell};
use callback::Loopback;
use popup::{PopupHost, TokenSource};
use prefs::{DisplayMode, PreferenceStore};
use shell::{PopupHandle, ShellEvents, ShellGoogle, ShellPopupEvents};
use vault::{KeychainVault, Vault, VaultError};
use window::WindowState;

/// The preview's identifier, for tests that need a Keychain service; the app
/// itself reads its identity from the bundle configuration (`identity.rs`).
pub const PREVIEW_BUNDLE_ID: &str = "app.openedbot.desktop.preview";
/// The preview's OAuth client id on macOS, for the IPC tests.
pub const PREVIEW_CLIENT_ID: &str = "openedbot-desktop-macos-preview";
/// Show or hide the window from anywhere.
pub const TOGGLE_SHORTCUT: &str = "CommandOrControl+Shift+O";

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

/// Whether the OS hands `openedbot://` links to this app. macOS reads the
/// scheme from the bundle's Info.plist at install; elsewhere it is registered
/// at run time, and a refusal falls back to the loopback page.
fn deep_link_registered<R: Runtime>(app: &AppHandle<R>, identity: &identity::Identity) -> bool {
    if !identity.declares_scheme {
        return false;
    }
    if cfg!(target_os = "macos") {
        return true;
    }
    use tauri_plugin_deep_link::DeepLinkExt;
    match app.deep_link().register(callback::SCHEME) {
        Ok(()) => true,
        Err(error) => {
            log::warn!("openedbot:// registration failed ({error}), falling back to the loopback callback");
            false
        }
    }
}

/// The exit status after a refused configuration (EX_CONFIG).
const EXIT_CONFIG: i32 = 78;

/// What the user reads when the configuration is refused: the app cannot
/// start, and a silent exit would look like a crash.
pub fn config_refused_message(product: &str, error: &config::ConfigError, file: Option<&std::path::Path>) -> String {
    let file = file.map(|path| path.display().to_string()).unwrap_or_else(|| "config.json".into());
    format!(
        "{product} ne peut pas démarrer : sa configuration est refusée ({error}).\n\nCorrigez ou supprimez {file}, ou la variable d’environnement en cause, puis relancez l’app."
    )
}

fn setup<R: Runtime>(app: &mut tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let identity = identity::Identity::from_config(app.config(), &app.package_info().name);
    if let Ok(dir) = app.path().app_log_dir() {
        logger::init(dir, identity.log_file());
    }
    let product = identity.product.clone();
    let version = app.package_info().version.to_string();
    let data_dir = app.path().app_data_dir().ok();
    if let Some(dir) = &data_dir {
        let _ = std::fs::create_dir_all(dir);
        diagnostics::open(&dir.join("diagnostics.sqlite"), &format!("{product} {version}, {} {}", std::env::consts::OS, std::env::consts::ARCH));
    }
    // `make desktop-dev`: the console comes from the Vite dev server.
    if let Some(dev_url) = app.config().build.dev_url.clone() {
        if tauri::is_dev() && !window::use_dev_origin(&dev_url) {
            log::error!("dev server refused (plain http on the loopback only)");
        } else if tauri::is_dev() {
            log::info!("console from the dev server {}", dev_url.origin().ascii_serialization());
        }
    }
    let env = |name: &str| std::env::var(name).ok();
    let config_dir = app.path().app_config_dir().ok();
    let config = match config::load(config_dir.as_deref(), &env, identity.production) {
        Ok(config) => config,
        Err(error) => {
            log::error!("configuration refused: {error}");
            use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
            let file = config_dir.as_ref().map(|dir| dir.join("config.json"));
            // Not blocking: the dialog needs the event loop this callback runs
            // on. Nothing else starts (no window, session, popup or update);
            // the app quits once the dialog is closed.
            app.dialog()
                .message(config_refused_message(&product, &error, file.as_deref()))
                .title("Configuration refusée")
                .kind(MessageDialogKind::Error)
                .show(|_| std::process::exit(EXIT_CONFIG));
            return Ok(());
        }
    };
    log::info!("{product} {version}, API {}, updates {}", config.api_origin, config.update_url.as_deref().unwrap_or("off"));

    let prefs = Arc::new(PreferenceStore::open(data_dir.as_deref()));
    app.manage(WindowState::new(prefs.clone()));
    app.manage(notch::NotchSession::default());
    app.manage(shell::Purging::default());
    let update_status = Arc::new(update_state::UpdateStatus::new(prefs.get().auto_install_updates, {
        let app = app.handle().clone();
        Box::new(move |state, summary_changed| {
            use tauri_specta::Event;
            if let Err(error) = bridge::UpdateStateChanged(state.clone()).emit(&app) {
                log::warn!("update state not delivered ({error})");
            }
            if summary_changed {
                if let Some(popup) = app.try_state::<PopupHandle>() {
                    popup.0.notify(shell::update_line(state));
                }
                #[cfg(target_os = "macos")]
                macos::menu::refresh_update_item(&app, state);
            }
        })
    }));
    app.manage(update_status.clone());

    let vault: Box<dyn Vault> = if std::env::var("OPENEDBOT_PREVIEW_VAULT").as_deref() == Ok("memory") {
        Box::new(DisabledVault)
    } else {
        Box::new(KeychainVault::new(&identity.bundle_id, &config.api_origin))
    };
    let registered = deep_link_registered(&handle, &identity);
    let redirect_uri = callback::redirect_uri(registered);
    let returned = handle.clone();
    let google = Arc::new(ShellGoogle {
        app: handle.clone(),
        loopback: Loopback::new(callback::LOOPBACK_PORT, Arc::new(move || shell::browser_returned(&returned))),
        uses_loopback: !registered,
    });
    let events: Arc<dyn AuthEvents> = Arc::new(ShellEvents { app: handle.clone() });
    let auth: Arc<Auth> = Arc::new(AuthService::new(HttpAuthApi::new(&config.api_origin, &version), vault, events, redirect_uri, &identity.client_id));
    let restored = auth.restore();
    log::info!("session {} ({:?}), browser return by {redirect_uri}", if restored { "restored" } else { "absent" }, auth.persistence());

    let opener_handle = handle.clone();
    app.manage(Shell {
        auth: auth.clone(),
        config: config.clone(),
        version: version.clone(),
        opener: Box::new(move |url: &Url| {
            use tauri_plugin_opener::OpenerExt;
            opener_handle.opener().open_url(url.as_str(), None::<&str>).map_err(|error| error.to_string())
        }),
        google,
        client_id: identity.client_id.clone(),
        window: Box::new(window::MainWindowControl(handle.clone())),
        notch: Box::new(window::AppNotchControl(handle.clone())),
    });

    // The popup host exists whenever the popup is supported: the Dock menu
    // greys its modes when no bundle is found.
    if shell::POPUP_SUPPORTED {
        let executable = std::env::current_exe()?;
        let bundle = popup::locate_bundle(&executable, std::env::var_os("OPENEDBOT_POPUP_APP").map(Into::into));
        let host = PopupHost::new(bundle, &config.api_origin, &config.public_console_url, auth.clone(), Arc::new(ShellPopupEvents { app: handle.clone() }));
        app.manage(PopupHandle(host));
    }
    let mode = shell::display_mode(&handle);
    let start = if restored { window::START_PATH } else { window::LOGIN_PATH };
    let visible = !(mode == DisplayMode::Popup && restored);

    // Data stored for another backend (or by a build that did not record
    // one) is purged before the console loads: one store, one backend.
    let stale = prefs.get().data_origin.as_deref() != Some(config.api_origin.as_str());
    window::build(&handle, &config, &version, (!stale).then_some(start), visible)?;
    // Only now: a session lost at the first refresh purges a window that exists.
    tauri::async_runtime::spawn(auth.clone().keep_fresh());
    if stale {
        let purging = handle.clone();
        tauri::async_runtime::spawn(async move {
            let chooser = purging.clone();
            let purged = shell::purge_and_open(&purging, move || {
                let signed_in = chooser.try_state::<Shell>().is_some_and(|shell| shell.auth.is_signed_in());
                if signed_in { window::START_PATH } else { window::LOGIN_PATH }.to_string()
            })
            .await;
            if purged == Some(true) {
                log::info!("WebView data of another backend purged");
            }
        });
    }
    // The popup only runs with a session (and asks the first-run choice if
    // nothing was chosen); otherwise it starts at sign-in.
    if restored {
        notch::session_started(&handle);
    }

    #[cfg(target_os = "macos")]
    {
        app.set_menu(macos::menu::build(&handle)?)?;
        let dock = handle.clone();
        macos::dock::install(
            &handle,
            Box::new(move |action| match action {
                macos::dock::DockAction::DisplayMode(mode) => shell::set_display_mode(&dock, mode),
                macos::dock::DockAction::ToggleAlwaysOnTop => {
                    let current = dock.state::<WindowState>().prefs.get().always_on_top;
                    shell::set_always_on_top(&dock, !current);
                }
                macos::dock::DockAction::SignOut => shell::sign_out_from_menu(&dock),
            }),
        );
    }
    #[cfg(target_os = "linux")]
    linux::setup(app);
    shell::visibility_changed(&handle);

    app.manage(ToggleShortcut::default());
    ensure_toggle_shortcut(&handle);
    {
        use tauri_plugin_notification::NotificationExt;
        // A click on the notification itself (`tap`); the page's notifications carry no actions.
        let clicked = handle.clone();
        app.notification().on_action(move |performed| {
            if performed.action_id() == "tap" {
                shell::notification_clicked(&clicked, performed.notification().map(|notification| notification.id()));
            }
        })?;
    }
    {
        use tauri_plugin_deep_link::DeepLinkExt;
        let linked = handle.clone();
        app.deep_link().on_open_url(move |event| {
            if event.urls().iter().any(|url| callback::is_auth_callback(url.as_str())) {
                shell::browser_returned(&linked);
            }
        });
    }

    start_updates(&handle, &config, update_status, &product)?;
    app.manage(identity);
    Ok(())
}

/// Whether the show/hide shortcut is ours. Another app may hold it (an older
/// openedbot still running): then the window works without it,
/// and the shortcut is asked for again each time the window gains focus, so
/// it comes back once that app has quit.
#[derive(Default)]
pub struct ToggleShortcut {
    registered: std::sync::atomic::AtomicBool,
    warned: std::sync::atomic::AtomicBool,
}

/// Registers the shortcut unless already ours; never fatal.
pub fn ensure_toggle_shortcut<R: Runtime>(app: &AppHandle<R>) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let Some(state) = app.try_state::<ToggleShortcut>() else { return };
    if state.registered.load(Ordering::SeqCst) {
        return;
    }
    match app.global_shortcut().register(TOGGLE_SHORTCUT) {
        Ok(()) => {
            state.registered.store(true, Ordering::SeqCst);
            if state.warned.load(Ordering::SeqCst) {
                log::info!("global shortcut {TOGGLE_SHORTCUT} registered after all");
            }
        }
        // Once: the retry runs on every focus.
        Err(error) if !state.warned.swap(true, Ordering::SeqCst) => {
            log::warn!("global shortcut {TOGGLE_SHORTCUT} unavailable ({error}), asked again when the window gains focus");
        }
        Err(_) => {}
    }
}

/// The update engine on the configured feed, its checks and the idle
/// install; without a feed, a control that does nothing.
fn start_updates<R: Runtime>(app: &AppHandle<R>, config: &config::ShellConfig, status: Arc<update_state::UpdateStatus>, product: &str) -> Result<(), Box<dyn std::error::Error>> {
    let Some(manifest) = config.update_url.as_deref() else {
        app.manage(bridge::Updates(Arc::new(update_engine::NoUpdates(status))));
        return Ok(());
    };
    // A deb belongs to the package manager (D5): no check, no download.
    #[cfg(target_os = "linux")]
    if !linux::self_update_supported() {
        log::info!("not an AppImage: updates come from the package manager, update check skipped");
        app.manage(bridge::Updates(Arc::new(update_engine::NoUpdates(status))));
        return Ok(());
    }
    let endpoint: Url = manifest.parse()?;
    let current = semver::Version::parse(&app.package_info().version.to_string())?;
    // Unix seconds, set by `scripts/build-mac.ts`: the manifest's `max_age_days` reads it.
    let built_at = option_env!("OPENEDBOT_BUILT_AT").and_then(|text| text.parse::<u64>().ok());
    if built_at.is_none() {
        log::info!("no build time embedded: the manifest's max_age_days does not apply");
    }
    let engine = update_engine::UpdateEngine::new(updater::TauriFeed::new(app.clone(), endpoint), status.clone(), updater::install_hooks(app), current, built_at);
    let control: Arc<dyn update_engine::UpdateControl> = Arc::new(engine);
    app.manage(bridge::Updates(control.clone()));
    let moving = app.clone();
    let title = format!("Déplacez {product} dans Applications");
    updater::spawn_checks(status.clone(), control.clone(), move || {
        shell::warn(
            &moving,
            &title,
            "macOS fait tourner cette copie depuis un emplacement en lecture seule : les mises à jour ne peuvent pas s’y installer. Quittez l’app, glissez-la dans le dossier Applications depuis le Finder, puis relancez-la.",
        );
    });
    #[cfg(target_os = "macos")]
    let idle: Arc<dyn update_idle::IdleSource> = {
        let waking = status.clone();
        macos::idle::MacIdle::install(move || waking.wake())
    };
    #[cfg(not(target_os = "macos"))]
    let idle: Arc<dyn update_idle::IdleSource> = Arc::new(update_idle::NeverIdle);
    let threshold = update_idle::idle_threshold(std::env::var("OPENEDBOT_UPDATE_IDLE_SECONDS").ok().as_deref());
    tauri::async_runtime::spawn(update_idle::run(status, control, idle, threshold));
    Ok(())
}

fn on_run_event<R: Runtime>(app: &AppHandle<R>, event: tauri::RunEvent) {
    match event {
        tauri::RunEvent::ExitRequested { .. } => {
            // Absent when the configuration was refused: nothing to save.
            if let Some(state) = app.try_state::<WindowState>() {
                state.quitting.store(true, Ordering::SeqCst);
            }
            window::save_placement(app);
        }
        // Quit from the app menu did not keep the placement through `ExitRequested` alone (observed): save here too.
        tauri::RunEvent::Exit => {
            if let Some(state) = app.try_state::<WindowState>() {
                state.quitting.store(true, Ordering::SeqCst);
            }
            window::save_placement(app);
            if let Some(popup) = app.try_state::<PopupHandle>() {
                // Closing its stdin is enough: the popup quits on EOF.
                popup.0.stop();
            }
        }
        // macOS: a Dock click on a hidden window brings it back, like any Mac app.
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            window::show(app);
            shell::visibility_changed(app);
        }
        _ => {}
    }
}

pub fn run() {
    let specta = bridge::specta_builder::<tauri::Wry>();
    // Single instance first: a second launch (or a deep link on Windows and
    // Linux) lands in the running app instead of opening a second window.
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if argv.iter().any(|arg| callback::is_auth_callback(arg)) {
                shell::browser_returned(app);
            } else {
                window::bring_to_front(app);
                shell::visibility_changed(app);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        window::toggle(app);
                        shell::visibility_changed(app);
                    }
                })
                .build(),
        )
        .invoke_handler(specta.invoke_handler())
        .on_window_event(window::on_window_event);
    #[cfg(all(debug_assertions, feature = "desktop-mcp"))]
    let builder = builder.plugin(tauri_plugin_mcp_app_desktop::init());
    #[cfg(target_os = "macos")]
    let builder = builder
        .on_menu_event(|app, event| macos::menu::on_menu_event(app, &event))
        // WKWebView's content process died (crash, memory pressure): journal it and reload.
        .on_web_content_process_terminate(|webview| {
            diagnostics::record(diagnostics::Level::Error, diagnostics::Source::Renderer, "web content process terminated", None);
            log::error!("the WebView's content process terminated, reloading");
            let _ = webview.reload();
        });
    let app = builder
        .setup(move |app| {
            specta.mount_events(app);
            setup(app)
        })
        .build(tauri::generate_context!())
        .expect("openedbot desktop failed to start");
    app.run(on_run_event);
}

#[cfg(test)]
mod ipc_tests;

#[cfg(test)]
mod tests {
    #[test]
    fn a_refused_configuration_says_what_and_where() {
        let message = super::config_refused_message("openedbot", &super::config::ConfigError::Insecure("OPENEDBOT_API_ORIGIN"), Some(std::path::Path::new("/Users/x/Library/Application Support/app.openedbot.desktop/config.json")));
        assert!(message.starts_with("openedbot ne peut pas démarrer"));
        assert!(message.contains("OPENEDBOT_API_ORIGIN must be https"));
        assert!(message.contains("app.openedbot.desktop/config.json"));
    }
}
