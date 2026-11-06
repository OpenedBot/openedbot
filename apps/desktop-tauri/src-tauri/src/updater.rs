//! Self-update: `tauri-plugin-updater` against the configured manifest
//! (`config.update_url`). The artifact is the `.app.tar.gz` signed with the
//! update key (minisign), distinct from the Developer ID; the public key is
//! in the plugin config (`plugins.updater.pubkey`, set at build time by
//! `scripts/build-mac.ts`). A bad signature, an unreachable feed or a stale
//! manifest leaves the installed version untouched: the error is logged.
//!
//! Checked shortly after launch, then every few hours while the app runs. At
//! launch an update installs and restarts at once; later, the user chooses
//! when to restart, and no other check runs until then. The notch popup,
//! whose executable lives inside the bundle, is stopped, and its exit
//! awaited, before the bundle is replaced.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_updater::UpdaterExt;

use crate::update_state::{progress_step, UpdateErrorCode, UpdateState, UpdateStatus};

/// How long after launch the first check starts: the window first.
const FIRST_CHECK: Duration = Duration::from_secs(3);
const CHECK_EVERY: Duration = Duration::from_secs(4 * 60 * 60);
/// The shortest period `OPENEDBOT_UPDATE_CHECK_SECONDS` may set (tests of a running app).
const MIN_CHECK_EVERY: Duration = Duration::from_secs(30);

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// What the shell does around an update.
pub struct UpdateHooks {
    /// Right before the bundle is replaced, once the artifact is downloaded
    /// and its signature verified: stops the popup and waits for its exit.
    /// `false` refuses the install.
    pub before_install: Box<dyn Fn() -> BoxFuture<bool> + Send + Sync>,
    /// The popup runs again: the install failed, or it waits for a restart.
    pub resume: Box<dyn Fn() + Send + Sync>,
    /// Installed during a session: may the app restart now?
    pub confirm_restart: Box<dyn Fn(String) -> BoxFuture<bool> + Send + Sync>,
    /// The app runs translocated: told once, no update is ever tried.
    pub translocated: Box<dyn Fn() + Send + Sync>,
}

/// macOS runs a quarantined app that the user did not move with Finder from
/// a read-only randomized mount (App Translocation): the bundle cannot be
/// replaced there, so the update is not even downloaded.
pub fn is_translocated(executable: &std::path::Path) -> bool {
    executable.components().any(|part| part.as_os_str() == "AppTranslocation")
}

/// The period between checks: `OPENEDBOT_UPDATE_CHECK_SECONDS` when set and
/// sane, otherwise four hours.
pub fn check_period(raw: Option<&str>) -> Duration {
    raw.and_then(|value| value.trim().parse::<u64>().ok()).map(Duration::from_secs).filter(|period| *period >= MIN_CHECK_EVERY).unwrap_or(CHECK_EVERY)
}

pub fn spawn_checks<R: Runtime>(app: AppHandle<R>, manifest: String, hooks: UpdateHooks) {
    let period = check_period(std::env::var("OPENEDBOT_UPDATE_CHECK_SECONDS").ok().as_deref());
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        if std::env::current_exe().is_ok_and(|executable| is_translocated(&executable)) {
            log::warn!("the app runs translocated (not moved to Applications by the user): updates disabled");
            report(&app, UpdateState::Error { code: UpdateErrorCode::Translocated });
            (hooks.translocated)();
            return;
        }
        let (checking, restarting, pausing) = (app.clone(), app.clone(), app.clone());
        run_checks(
            || check_and_install(&checking, &manifest, &hooks),
            |version| (hooks.confirm_restart)(version),
            || (hooks.resume)(),
            || restarting.restart(),
            || {
                let app = pausing.clone();
                async move {
                    // The period, or sooner when the API said an update is required.
                    let status = app.state::<UpdateStatus>();
                    tokio::select! {
                        _ = tokio::time::sleep(period) => {}
                        _ = status.woken() => log::info!("update required by the API: checking now"),
                    }
                }
            },
        )
        .await;
    });
}

/// The check loop. Returns once an update is installed and its restart
/// deferred: the bundle on disk is then the new version while the running
/// process keeps its old number, so checking again would download and
/// install the same release every period.
async fn run_checks<Check, Confirm, Pause, E>(
    mut check: impl FnMut() -> Check,
    mut confirm_restart: impl FnMut(String) -> Confirm,
    mut resume: impl FnMut(),
    mut restart: impl FnMut(),
    mut pause: impl FnMut() -> Pause,
) where
    Check: Future<Output = Result<Option<String>, E>>,
    Confirm: Future<Output = bool>,
    Pause: Future<Output = ()>,
    E: std::fmt::Display,
{
    let mut at_launch = true;
    loop {
        match check().await {
            Ok(Some(version)) => {
                if at_launch || confirm_restart(version.clone()).await {
                    log::info!("update {version} installed, restarting");
                    restart();
                }
                log::info!("update {version} installed, applied at the next launch; no further check until then");
                resume();
                return;
            }
            Ok(None) => {}
            Err(error) => log::error!("update refused or failed, installed version kept ({error})"),
        }
        at_launch = false;
        pause().await;
    }
}

#[derive(Debug, thiserror::Error)]
enum UpdateError {
    #[error(transparent)]
    Updater(#[from] tauri_plugin_updater::Error),
    #[error(transparent)]
    Url(#[from] url::ParseError),
    #[error("the popup did not stop: install refused")]
    PopupStillRunning,
}

fn report<R: Runtime>(app: &AppHandle<R>, state: UpdateState) {
    if let Some(status) = app.try_state::<UpdateStatus>() {
        status.set(state);
    }
}

fn failed<R: Runtime>(app: &AppHandle<R>, code: UpdateErrorCode, error: impl Into<UpdateError>) -> UpdateError {
    report(app, UpdateState::Error { code });
    error.into()
}

/// A download that failed on the signature (forged, other key, version
/// mismatch) is told apart from one that failed on the way.
fn download_error_code(error: &tauri_plugin_updater::Error) -> UpdateErrorCode {
    use tauri_plugin_updater::Error;
    match error {
        Error::Minisign(_) | Error::Base64(_) | Error::SignatureUtf8(_) | Error::SignedVersionMismatch { .. } | Error::MissingSignedVersion => UpdateErrorCode::SignatureRefused,
        _ => UpdateErrorCode::DownloadFailed,
    }
}

/// `Some(version)` once installed. Each step is published (`UpdateStatus`).
async fn check_and_install<R: Runtime>(app: &AppHandle<R>, manifest: &str, hooks: &UpdateHooks) -> Result<Option<String>, UpdateError> {
    let current = app.package_info().version.to_string();
    let endpoint: url::Url = manifest.parse().map_err(|error| failed(app, UpdateErrorCode::FeedUnreachable, error))?;
    let updater = app.updater_builder().endpoints(vec![endpoint])?.build()?;
    log::info!("checking for updates (current {current})");
    let checked = updater.check().await.map_err(|error| failed(app, UpdateErrorCode::FeedUnreachable, error))?;
    let Some(update) = checked else {
        log::info!("up to date ({current})");
        if let Some(status) = app.try_state::<UpdateStatus>() {
            status.up_to_date();
        }
        return Ok(None);
    };
    let version = update.version.clone();
    log::info!("update {version} available (current {current}), downloading");
    report(app, UpdateState::Available { version: version.clone() });
    // `download` verifies the signature against the update key: a forged or
    // corrupted artifact stops here, before anything on disk changes.
    let mut received: u64 = 0;
    let progress = |chunk: usize, total: Option<u64>| {
        let before = received;
        received += chunk as u64;
        if before == 0 || progress_step(before, received, total) {
            let clamp = |bytes: u64| u32::try_from(bytes).unwrap_or(u32::MAX);
            report(app, UpdateState::Downloading { version: version.clone(), downloaded: clamp(received), total: total.map(clamp) });
        }
    };
    let bytes = update.download(progress, || {}).await.map_err(|error| failed(app, download_error_code(&error), error))?;
    log::info!("update {version} downloaded ({} bytes), signature verified", bytes.len());
    if !(hooks.before_install)().await {
        (hooks.resume)();
        return Err(failed(app, UpdateErrorCode::PopupStillRunning, UpdateError::PopupStillRunning));
    }
    if let Err(error) = update.install(&bytes) {
        (hooks.resume)();
        return Err(failed(app, UpdateErrorCode::InstallFailed, error));
    }
    log::info!("update {version} installed");
    report(app, UpdateState::Ready { version: version.clone() });
    Ok(Some(version))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn a_signature_failure_is_told_apart_from_a_network_one() {
        use tauri_plugin_updater::Error;
        assert_eq!(download_error_code(&Error::SignatureUtf8("x".into())), UpdateErrorCode::SignatureRefused);
        assert_eq!(download_error_code(&Error::MissingSignedVersion), UpdateErrorCode::SignatureRefused);
        assert_eq!(download_error_code(&Error::Network("reset".into())), UpdateErrorCode::DownloadFailed);
    }

    #[test]
    fn spots_a_translocated_bundle() {
        assert!(is_translocated(Path::new(
            "/private/var/folders/t8/x/T/AppTranslocation/C3D5/d/openedbot preview.app/Contents/MacOS/openedbot-desktop-preview"
        )));
        assert!(!is_translocated(Path::new("/Applications/openedbot preview.app/Contents/MacOS/openedbot-desktop-preview")));
    }

    #[tokio::test]
    async fn a_deferred_restart_ends_the_checks() {
        use std::cell::Cell;
        let checks = Cell::new(0);
        let asked = Cell::new(0);
        let resumed = Cell::new(0);
        run_checks(
            || {
                checks.set(checks.get() + 1);
                // Up to date at launch, then the same release on every later check.
                let found = (checks.get() > 1).then(|| "1.1.0".to_string());
                async move { Ok::<_, std::convert::Infallible>(found) }
            },
            |_| {
                asked.set(asked.get() + 1);
                async { false }
            },
            || resumed.set(resumed.get() + 1),
            || panic!("no restart was accepted"),
            || async {},
        )
        .await;
        assert_eq!((checks.get(), asked.get(), resumed.get()), (2, 1, 1), "installed once, asked once, then stopped");
    }

    #[tokio::test]
    async fn an_update_found_at_launch_restarts_without_asking() {
        use std::cell::Cell;
        let restarted = Cell::new(false);
        run_checks(
            || async { Ok::<_, std::convert::Infallible>(Some("1.1.0".to_string())) },
            |_| -> std::future::Ready<bool> { panic!("not asked at launch") },
            || {},
            || restarted.set(true),
            || async {},
        )
        .await;
        assert!(restarted.get());
    }

    #[tokio::test]
    async fn a_failed_check_tries_again_next_period() {
        use std::cell::Cell;
        let checks = Cell::new(0);
        run_checks(
            || {
                checks.set(checks.get() + 1);
                let outcome = if checks.get() < 3 { Err("feed unreachable") } else { Ok(Some("1.1.0".to_string())) };
                async move { outcome }
            },
            |_| async { false },
            || {},
            || {},
            || async {},
        )
        .await;
        assert_eq!(checks.get(), 3);
    }

    #[test]
    fn checks_every_four_hours_unless_told_otherwise() {
        assert_eq!(check_period(None), CHECK_EVERY);
        assert_eq!(check_period(Some("60")), Duration::from_secs(60));
        assert_eq!(check_period(Some("5")), CHECK_EVERY, "below the floor");
        assert_eq!(check_period(Some("soon")), CHECK_EVERY);
    }
}
