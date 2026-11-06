//! Linux specifics of the shell (ADR 0001, steps D5 and D6), kept out of the
//! shared modules: the deep link, the tray, and which installs may replace
//! themselves. One instance, the close button (hides) and the
//! global shortcut are shared with macOS (`lib.rs`, `window.rs`).
//!
//! The session vault is the shared `vault.rs`: on Linux the `keyring` crate
//! talks to the Secret Service (GNOME Keyring, KWallet) over D-Bus. Without
//! one, the vault refuses and the session lives in memory only; nothing is
//! ever written in clear (tests below).

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::utils::config::BundleType;
use tauri::{AppHandle, Runtime};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

use crate::{shell, window};

/// The preview's URL scheme (`tauri.linux.conf.json`), so that it never takes
/// `openedbot://` from the installed production app (`tauri.production.conf.json`).
pub const SCHEME: &str = "openedbot-preview";

/// Deep link and tray, once the main window exists.
pub fn setup<R: Runtime>(app: &tauri::App<R>) {
    let handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            open_url(&handle, &url);
        }
    });
    // The deb declares the scheme in its .desktop entry; an AppImage has no
    // installed entry, so it registers one for the user at each launch (it may
    // have moved).
    if is_appimage() {
        if let Err(error) = app.deep_link().register_all() {
            log::warn!("deep link scheme not registered ({error})");
        }
    }
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in urls {
            open_url(app.handle(), &url);
        }
    }
    // A desktop without a StatusNotifier host (GNOME without the AppIndicator
    // extension) shows no icon: the window and the menu entry remain the way in.
    if let Err(error) = tray(app) {
        log::warn!("tray icon unavailable ({error})");
    }
}

/// Only an AppImage replaces itself (`tauri-plugin-updater` swaps the file
/// `$APPIMAGE` points at). A deb belongs to the package manager.
pub fn self_update_supported() -> bool {
    is_appimage()
}

fn is_appimage() -> bool {
    tauri::utils::platform::bundle_type() == Some(BundleType::AppImage)
}

/// What a deep link of this app does: bring it to the front (the Google
/// return also reaches `lib.rs`, which ends the sign-in). Only the scheme and
/// host are logged, never the query.
fn open_url<R: Runtime>(app: &AppHandle<R>, url: &Url) {
    if url.scheme() != SCHEME && url.scheme() != crate::callback::SCHEME {
        return;
    }
    log::info!("deep link {}://{}", url.scheme(), url.host_str().unwrap_or(""));
    window::bring_to_front(app);
    shell::visibility_changed(app);
}

/// The tray menu: show or hide, sign out, quit.
fn tray<R: Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "Afficher / Masquer", true, None::<&str>)?;
    let sign_out = MenuItem::with_id(app, "sign-out", "Se déconnecter", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &PredefinedMenuItem::separator(app)?, &sign_out, &PredefinedMenuItem::separator(app)?, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main").tooltip(&app.package_info().name).menu(&menu).on_menu_event(|app, event| match event.id().as_ref() {
        "toggle" => {
            window::toggle(app);
            shell::visibility_changed(app);
        }
        "sign-out" => shell::sign_out_from_menu(app),
        // `ExitRequested` marks the app as quitting, so the window closes for real.
        "quit" => app.exit(0),
        _ => {}
    });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::vault::{KeychainVault, Vault};
    use std::path::Path;
    use std::process::Command;

    const CHILD: &str = "OPENEDBOT_LINUX_VAULT_CHILD";

    fn files_under(dir: &Path) -> Vec<String> {
        let mut found = Vec::new();
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                found.extend(files_under(&path));
            } else {
                found.push(path.display().to_string());
            }
        }
        found
    }

    /// No Secret Service (no session bus at all): the real keyring backend
    /// refuses to load and to save, and nothing lands on disk. The bus and
    /// home variables are process-wide, so the probe runs in a child process
    /// of this test binary with its own environment.
    #[test]
    fn without_a_secret_service_the_vault_refuses_and_writes_nothing() {
        let home = std::env::temp_dir().join(format!("openedbot-linux-vault-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "linux::tests::child_vault_without_keystore", "--ignored", "--nocapture", "--test-threads=1"])
            .env(CHILD, "1")
            .env("DBUS_SESSION_BUS_ADDRESS", format!("unix:path={}/no-bus", home.display()))
            .env_remove("DISPLAY")
            .env("HOME", &home)
            .env("XDG_DATA_HOME", home.join("data"))
            .env("XDG_CONFIG_HOME", home.join("config"))
            .env("XDG_CACHE_HOME", home.join("cache"))
            .env("XDG_RUNTIME_DIR", home.join("run"))
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(output.status.success(), "{stdout}{}", String::from_utf8_lossy(&output.stderr));
        assert!(stdout.contains("1 passed"), "the probe did not run: {stdout}");
        let written = files_under(&home);
        std::fs::remove_dir_all(&home).unwrap();
        assert!(written.is_empty(), "the vault wrote files: {written:?}");
    }

    #[test]
    #[ignore = "run in a child process by without_a_secret_service_the_vault_refuses_and_writes_nothing"]
    fn child_vault_without_keystore() {
        assert_eq!(std::env::var(CHILD).as_deref(), Ok("1"), "only meaningful in the child process");
        let vault = KeychainVault::new(crate::PREVIEW_BUNDLE_ID, "http://127.0.0.1:8790");
        assert!(vault.load().is_err(), "a missing Secret Service must be an error, not an empty vault");
        assert!(vault.save("refresh-token-that-must-not-persist").is_err());
        assert!(vault.load().is_err());
    }

    /// With a Secret Service (the Docker run starts an unlocked GNOME Keyring):
    /// save, read back, clear. `cargo test -- --ignored --exact linux::tests::secret_service_round_trip`.
    #[test]
    #[ignore = "needs a running, unlocked Secret Service"]
    fn secret_service_round_trip() {
        let vault = KeychainVault::new(crate::PREVIEW_BUNDLE_ID, &format!("http://127.0.0.1:{}", 10_000 + std::process::id() % 50_000));
        vault.clear().unwrap();
        assert_eq!(vault.load().unwrap(), None);
        vault.save("{\"refreshToken\":\"round-trip\"}").unwrap();
        assert_eq!(vault.load().unwrap().as_deref(), Some("{\"refreshToken\":\"round-trip\"}"));
        vault.clear().unwrap();
        assert_eq!(vault.load().unwrap(), None);
    }
}
