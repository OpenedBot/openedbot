//! Self-update, the Tauri side: `tauri-plugin-updater` against the
//! configured manifest (`config.update_url`) as the engine's `Feed`
//! (`update_engine.rs`), the cadence of the checks, and what the shell does
//! around an install. The artifact is the `.app.tar.gz` signed with the
//! update key (minisign), distinct from the Developer ID; the public key is
//! in the plugin config (`plugins.updater.pubkey`, set at build time by
//! `scripts/build-mac.ts`). A bad signature, an unreachable feed or a stale
//! manifest leaves the installed version untouched: the error is logged.
//!
//! Cadence: a first check 30 s after launch, then every hour plus up to five
//! random minutes, and at once on a manual check, a 426 from the API or a
//! wake from sleep. A download starts as soon as the feed offers a version;
//! the install waits for consent (or the idle conditions, `update_idle.rs`).
//! The notch popup, whose executable lives inside the bundle, is stopped,
//! and its exit awaited, before the bundle is replaced.

use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_updater::UpdaterExt;
use url::Url;

use crate::shell::PopupHandle;
use crate::update_engine::{BoxFuture, DownloadFailure, Feed, FeedFailure, InstallHooks, ManifestFloor, Offer, Progress, UpdateControl};
use crate::update_state::{UpdateErrorCode, UpdateStatus};

/// How long after launch the first check starts: the window first.
const FIRST_CHECK: Duration = Duration::from_secs(30);
const CHECK_EVERY: Duration = Duration::from_secs(60 * 60);
/// The shortest period `OPENEDBOT_UPDATE_CHECK_SECONDS` may set (tests of a running app).
const MIN_CHECK_EVERY: Duration = Duration::from_secs(30);
/// Spread over five minutes so that every client of a release does not ask at once.
const MAX_JITTER: Duration = Duration::from_secs(5 * 60);
/// A check, or a download of the artifact, gives up after this long.
const REQUEST_LIMIT: Duration = Duration::from_secs(10 * 60);
/// How long an install waits for the popup to leave before it refuses.
const POPUP_EXIT_LIMIT: Duration = Duration::from_secs(5);

/// macOS runs a quarantined app that the user did not move with Finder from
/// a read-only randomized mount (App Translocation): the bundle cannot be
/// replaced there, so the update is not even downloaded.
pub fn is_translocated(executable: &std::path::Path) -> bool {
    executable.components().any(|part| part.as_os_str() == "AppTranslocation")
}

/// The period between checks: `OPENEDBOT_UPDATE_CHECK_SECONDS` when set and
/// sane, otherwise an hour.
pub fn check_period(raw: Option<&str>) -> Duration {
    raw.and_then(|value| value.trim().parse::<u64>().ok()).map(Duration::from_secs).filter(|period| *period >= MIN_CHECK_EVERY).unwrap_or(CHECK_EVERY)
}

/// The wait before the next check: the period plus a random share of at
/// most five minutes, and never more than a twelfth of the period.
pub fn next_wait(period: Duration, random: f64) -> Duration {
    let spread = MAX_JITTER.min(period / 12);
    period + spread.mul_f64(random.clamp(0.0, 1.0))
}

/// The feed of `tauri-plugin-updater`, one endpoint.
pub struct TauriFeed<R: Runtime> {
    app: AppHandle<R>,
    endpoint: Url,
    translocated: bool,
}

impl<R: Runtime> TauriFeed<R> {
    pub fn new(app: AppHandle<R>, endpoint: Url) -> Self {
        let translocated = std::env::current_exe().is_ok_and(|executable| is_translocated(&executable));
        Self { app, endpoint, translocated }
    }
}

/// A download that failed on the signature (forged, other key, version
/// mismatch) is told apart from one that failed on the way.
fn download_failure(error: tauri_plugin_updater::Error) -> DownloadFailure {
    use tauri_plugin_updater::Error;
    match error {
        Error::Minisign(_) | Error::Base64(_) | Error::SignatureUtf8(_) | Error::SignedVersionMismatch { .. } | Error::MissingSignedVersion => DownloadFailure::Signature(error.to_string()),
        _ => DownloadFailure::Network(error.to_string()),
    }
}

impl<R: Runtime> Feed for TauriFeed<R> {
    type Release = tauri_plugin_updater::Update;

    fn check(&self) -> BoxFuture<'_, Result<Option<Offer<Self::Release>>, FeedFailure>> {
        Box::pin(async move {
            if self.translocated {
                return Err(FeedFailure::Translocated);
            }
            let unreachable = |error: tauri_plugin_updater::Error| FeedFailure::Unreachable(error.to_string());
            let updater = self.app.updater_builder().endpoints(vec![self.endpoint.clone()]).map_err(unreachable)?.timeout(REQUEST_LIMIT).build().map_err(unreachable)?;
            let found = updater.check().await.map_err(unreachable)?;
            Ok(found.map(|update| Offer { version: update.version.clone(), signature: update.signature.clone(), floor: ManifestFloor::from_manifest(&update.raw_json), release: update }))
        })
    }

    fn download<'a>(&'a self, release: &'a Self::Release, mut progress: Progress) -> BoxFuture<'a, Result<Vec<u8>, DownloadFailure>> {
        // `download` verifies the signature against the update key: a forged
        // or corrupted artifact stops here, before anything on disk changes.
        Box::pin(async move { release.download(&mut progress, || {}).await.map_err(download_failure) })
    }

    fn install(&self, release: &Self::Release, bytes: &[u8]) -> Result<(), String> {
        release.install(bytes).map_err(|error| error.to_string())
    }
}

/// Starts the checks. Translocated, one dialog says why and nothing is ever
/// tried (a manual check is refused by the feed itself).
pub fn spawn_checks(status: Arc<UpdateStatus>, control: Arc<dyn UpdateControl>, translocated: impl Fn() + Send + 'static) {
    let period = check_period(std::env::var("OPENEDBOT_UPDATE_CHECK_SECONDS").ok().as_deref());
    tauri::async_runtime::spawn(async move {
        let wait = |delay: Duration| {
            let status = status.clone();
            async move {
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    _ = status.woken() => log::info!("update check wanted now"),
                }
            }
        };
        wait(FIRST_CHECK).await;
        if std::env::current_exe().is_ok_and(|executable| is_translocated(&executable)) {
            log::warn!("the app runs translocated (not moved to Applications by the user): updates disabled");
            status.failed(UpdateErrorCode::Translocated, false);
            translocated();
            return;
        }
        loop {
            control.check().await;
            wait(next_wait(period, rand::random::<f64>())).await;
        }
    });
}

/// Stops the popup before the bundle is replaced, starts it again when the
/// install did not happen, restarts the app once it did.
pub fn install_hooks<R: Runtime>(app: &AppHandle<R>) -> InstallHooks {
    let (stopping, resuming, restarting) = (app.clone(), app.clone(), app.clone());
    InstallHooks {
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
            // Whatever the session and the choice call for (demo, live or off).
            crate::notch::reconcile(&resuming);
        }),
        restart: Box::new(move || restarting.restart()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn a_signature_failure_is_told_apart_from_a_network_one() {
        use tauri_plugin_updater::Error;
        assert!(matches!(download_failure(Error::SignatureUtf8("x".into())), DownloadFailure::Signature(_)));
        assert!(matches!(download_failure(Error::MissingSignedVersion), DownloadFailure::Signature(_)));
        assert!(matches!(download_failure(Error::Network("reset".into())), DownloadFailure::Network(_)));
    }

    #[test]
    fn spots_a_translocated_bundle() {
        assert!(is_translocated(Path::new(
            "/private/var/folders/t8/x/T/AppTranslocation/C3D5/d/openedbot preview.app/Contents/MacOS/openedbot-desktop-preview"
        )));
        assert!(!is_translocated(Path::new("/Applications/openedbot preview.app/Contents/MacOS/openedbot-desktop-preview")));
    }

    #[test]
    fn checks_every_hour_unless_told_otherwise() {
        assert_eq!(check_period(None), CHECK_EVERY);
        assert_eq!(check_period(Some("60")), Duration::from_secs(60));
        assert_eq!(check_period(Some("5")), CHECK_EVERY, "below the floor");
        assert_eq!(check_period(Some("soon")), CHECK_EVERY);
    }

    #[test]
    fn the_wait_adds_up_to_five_random_minutes() {
        assert_eq!(next_wait(CHECK_EVERY, 0.0), CHECK_EVERY);
        assert_eq!(next_wait(CHECK_EVERY, 1.0), CHECK_EVERY + Duration::from_secs(300));
        assert_eq!(next_wait(CHECK_EVERY, 7.0), CHECK_EVERY + Duration::from_secs(300), "clamped");
        assert_eq!(next_wait(Duration::from_secs(60), 1.0), Duration::from_secs(65), "a short test period keeps a short spread");
    }
}
