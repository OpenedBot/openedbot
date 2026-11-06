//! openedbot desktop, Tauri 2 (ADR 0001, steps D2a then D2b: macOS parity).
//!
//! One window serves the console embedded in the app (`../console-dist`, the
//! solo desktop build) from the local origin (`tauri://localhost` on macOS,
//! `window.rs`). The session lives here (`auth.rs`, bearer, Keychain); the
//! console reaches it through the typed bridge (`bridge.rs`) only. The notch
//! popup is hosted over its stdin/stdout protocol (`popup.rs`), the app
//! updates itself from a signed feed (`updater.rs`), and `shell.rs` ties
//! session, window, popup and menus together like the Electron `main.ts`.
//!
//! The preview coexists with the Electron app: its own bundle identifier
//! (Keychain service), its own name, no `openedbot://` scheme.

pub mod auth;
pub mod bridge;
pub mod callback;
pub mod config;
pub mod csp;
pub mod diagnostics;
mod logger;
#[cfg(target_os = "macos")]
mod macos;
pub mod popup;
pub mod prefs;
pub mod shell;
pub mod update_state;
mod updater;
pub mod vault;
pub mod window;

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
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

pub const BUNDLE_ID: &str = "app.openedbot.desktop.preview";
/// The OAuth client id the API records for this build.
pub const CLIENT_ID: &str = "openedbot-desktop-macos-preview";
/// Show or hide the window from anywhere, as the Electron shell.
pub const TOGGLE_SHORTCUT: &str = "CommandOrControl+Shift+O";
/// How long an update waits for the popup to leave before it refuses to install.
const POPUP_EXIT_LIMIT: Duration = Duration::from_secs(5);

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
fn deep_link_registered<R: Runtime>(app: &AppHandle<R>) -> bool {
    if callback::DECLARED_SCHEME != Some(callback::SCHEME) {
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

fn setup<R: Runtime>(app: &mut tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    if let Ok(dir) = app.path().app_log_dir() {
        logger::init(dir);
    }
    let version = app.package_info().version.to_string();
    let data_dir = app.path().app_data_dir().ok();
    if let Some(dir) = &data_dir {
        let _ = std::fs::create_dir_all(dir);
        diagnostics::open(&dir.join("diagnostics.sqlite"), &format!("openedbot preview {version}, {} {}", std::env::consts::OS, std::env::consts::ARCH));
    }
    let env = |name: &str| std::env::var(name).ok();
    let config = config::load(app.path().app_config_dir().ok().as_deref(), &env).inspect_err(|error| log::error!("configuration refused: {error}"))?;
    log::info!("openedbot preview {version}, API {}", config.api_origin);

    let prefs = Arc::new(PreferenceStore::open(data_dir.as_deref()));
    app.manage(WindowState::new(prefs.clone()));
    app.manage(shell::Purging::default());
    app.manage(update_state::UpdateStatus::new(
        {
            let app = app.handle().clone();
            Box::new(move |state, status_changed| {
                use tauri_specta::Event;
                if let Err(error) = bridge::UpdateStateChanged(state.clone()).emit(&app) {
                    log::warn!("update state not delivered ({error})");
                }
                if status_changed {
                    if let Some(popup) = app.try_state::<PopupHandle>() {
                        let (status, version) = state.summary();
                        popup.0.notify(popup::HostToPopup::UpdateState { status, version: version.map(str::to_string) });
                    }
                }
            })
        },
        {
            let app = app.handle().clone();
            Box::new(move || app.restart())
        },
    ));

    let vault: Box<dyn Vault> = if std::env::var("OPENEDBOT_PREVIEW_VAULT").as_deref() == Ok("memory") {
        Box::new(DisabledVault)
    } else {
        Box::new(KeychainVault::new(BUNDLE_ID, &config.api_origin))
    };
    let registered = deep_link_registered(&handle);
    let redirect_uri = callback::redirect_uri(registered);
    let returned = handle.clone();
    let google = Arc::new(ShellGoogle {
        app: handle.clone(),
        loopback: Loopback::new(callback::LOOPBACK_PORT, Arc::new(move || shell::browser_returned(&returned))),
        uses_loopback: !registered,
    });
    let events: Arc<dyn AuthEvents> = Arc::new(ShellEvents { app: handle.clone() });
    let auth: Arc<Auth> = Arc::new(AuthService::new(HttpAuthApi::new(&config.api_origin, &version), vault, events, redirect_uri, CLIENT_ID));
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
        client_id: CLIENT_ID.into(),
        window: Box::new(window::MainWindowControl(handle.clone())),
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
    if mode != DisplayMode::Window {
        if let Some(popup) = app.try_state::<PopupHandle>() {
            popup.0.start();
        }
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
    shell::visibility_changed(&handle);

    {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        // Not fatal: the Dock icon still works. Another app may own the shortcut.
        if let Err(error) = app.global_shortcut().register(TOGGLE_SHORTCUT) {
            log::warn!("global shortcut {TOGGLE_SHORTCUT} unavailable ({error})");
        }
    }
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

    if let Some(manifest) = config.update_url.clone() {
        updater::spawn_checks(handle.clone(), manifest, update_hooks(&handle));
    }
    Ok(())
}

fn update_hooks<R: Runtime>(app: &AppHandle<R>) -> updater::UpdateHooks {
    let (stopping, resuming, asking, moving) = (app.clone(), app.clone(), app.clone(), app.clone());
    updater::UpdateHooks {
        before_install: Box::new(move || {
            let app = stopping.clone();
            Box::pin(async move {
                let Some(popup) = app.try_state::<PopupHandle>().map(|popup| popup.0.clone()) else { return true };
                log::info!("stopping the popup before the update replaces the bundle");
                // Held until `resume` or the restart: a Dock choice cannot relaunch it mid-install.
                let stopped = popup.hold_and_wait(POPUP_EXIT_LIMIT).await;
                if !stopped {
                    log::error!("the popup did not exit in time");
                }
                stopped
            })
        }),
        resume: Box::new(move || {
            let Some(popup) = resuming.try_state::<PopupHandle>() else { return };
            popup.0.release();
            if shell::display_mode(&resuming) != DisplayMode::Window {
                popup.0.start();
            }
        }),
        confirm_restart: Box::new(move |version| {
            let app = asking.clone();
            Box::pin(async move {
                use tauri_plugin_dialog::MessageDialogButtons;
                let (answer, answered) = tokio::sync::oneshot::channel();
                shell::dialog(&app, format!("openedbot preview {version} est installée. Redémarrez pour l’utiliser ; sinon elle s’ouvrira au prochain lancement."))
                .title("Mise à jour installée")
                    .buttons(MessageDialogButtons::OkCancelCustom("Redémarrer".into(), "Plus tard".into()))
                    .show(move |restart| {
                        let _ = answer.send(restart);
                    });
                answered.await.unwrap_or(false)
            })
        }),
        translocated: Box::new(move || {
            shell::warn(
                &moving,
                "Déplacez openedbot preview dans Applications",
                "macOS fait tourner cette copie depuis un emplacement en lecture seule : les mises à jour ne peuvent pas s’y installer. Quittez l’app, glissez-la dans le dossier Applications depuis le Finder, puis relancez-la.",
            );
        }),
    }
}

fn on_run_event<R: Runtime>(app: &AppHandle<R>, event: tauri::RunEvent) {
    match event {
        tauri::RunEvent::ExitRequested { .. } => {
            let state = app.state::<WindowState>();
            state.quitting.store(true, Ordering::SeqCst);
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
        .expect("openedbot preview failed to start");
    app.run(on_run_event);
}

#[cfg(test)]
mod ipc_tests;
