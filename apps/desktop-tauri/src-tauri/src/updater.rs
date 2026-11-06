//! Self-update: `tauri-plugin-updater` against the configured manifest
//! (`config.update_url`). The artifact is the `.app.tar.gz` signed with the
//! update key (minisign), distinct from the Developer ID; the public key is
//! in the plugin config (`plugins.updater.pubkey`, set at build time by
//! `scripts/build-mac.ts`). A bad signature, an unreachable feed or a stale
//! manifest leaves the installed version untouched: the error is logged.

use tauri::{AppHandle, Runtime};
use tauri_plugin_updater::UpdaterExt;

/// How long after launch the check starts: the window first.
const CHECK_DELAY: std::time::Duration = std::time::Duration::from_secs(3);

/// What the shell does around the bundle swap: `before_install` runs once
/// the artifact is downloaded and its signature verified, right before the
/// bundle is replaced (the shell stops the notch popup there, whose
/// executable lives inside the bundle, ADR 0001 section 5);
/// `after_failed_install` undoes it when the swap fails.
pub struct InstallHooks {
    pub before_install: Box<dyn FnOnce() + Send>,
    pub after_failed_install: Box<dyn FnOnce() + Send>,
}

/// macOS runs a quarantined app that the user did not move with Finder from
/// a read-only randomized mount (App Translocation): the bundle cannot be
/// replaced there, so the update is not even downloaded.
pub fn is_translocated(executable: &std::path::Path) -> bool {
    executable.components().any(|part| part.as_os_str() == "AppTranslocation")
}

pub fn spawn_check<R: Runtime>(app: AppHandle<R>, manifest: String, hooks: InstallHooks) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(CHECK_DELAY).await;
        if std::env::current_exe().is_ok_and(|executable| is_translocated(&executable)) {
            // D2b: tell the user to move the app to Applications.
            log::warn!("the app runs translocated (not moved to Applications by the user): update check skipped");
            return;
        }
        match check_and_install(&app, &manifest, hooks).await {
            Ok(true) => {
                log::info!("update installed, restarting");
                app.restart();
            }
            Ok(false) => {}
            Err(error) => log::error!("update refused or failed, installed version kept ({error})"),
        }
    });
}

async fn check_and_install<R: Runtime>(
    app: &AppHandle<R>,
    manifest: &str,
    hooks: InstallHooks,
) -> Result<bool, tauri_plugin_updater::Error> {
    let current = app.package_info().version.to_string();
    let endpoint: url::Url = manifest.parse()?;
    let updater = app.updater_builder().endpoints(vec![endpoint])?.build()?;
    log::info!("checking for updates (current {current})");
    let Some(update) = updater.check().await? else {
        log::info!("up to date ({current})");
        return Ok(false);
    };
    log::info!("update {} available (current {current}), downloading", update.version);
    // `download` verifies the signature against the update key: a forged or
    // corrupted artifact stops here, before anything on disk changes.
    let bytes = update.download(|_, _| {}, || {}).await?;
    log::info!("update {} downloaded ({} bytes), signature verified", update.version, bytes.len());
    (hooks.before_install)();
    if let Err(error) = update.install(&bytes) {
        (hooks.after_failed_install)();
        return Err(error);
    }
    log::info!("update {} installed", update.version);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn spots_a_translocated_bundle() {
        assert!(is_translocated(Path::new(
            "/private/var/folders/t8/x/T/AppTranslocation/C3D5/d/openedbot preview.app/Contents/MacOS/openedbot-desktop-preview"
        )));
        assert!(!is_translocated(Path::new("/Applications/openedbot preview.app/Contents/MacOS/openedbot-desktop-preview")));
    }
}
