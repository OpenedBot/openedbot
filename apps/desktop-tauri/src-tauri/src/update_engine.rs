//! The update's decisions, apart from Tauri: check the feed, download and
//! hold a verified artifact, install it only when asked (`install`), with the
//! version the asker saw. The feed is a trait (`Feed`): the app wraps
//! `tauri-plugin-updater` (`updater.rs`), tests use a scripted one.
//!
//! Rules:
//! - a download is silent and starts as soon as the feed offers a version;
//! - nothing replaces the bundle without `install` (the user's consent, or
//!   the idle conditions of `update_idle.rs`);
//! - `install` checks the feed once more: a version withdrawn meanwhile is
//!   dropped, a newer one supersedes it (downloaded next), and the stale one
//!   is never installed; an unreachable feed refuses rather than guesses;
//! - the manifest may carry a floor, `min_version` and `max_age_days` (the
//!   age of this build, `OPENEDBOT_BUILT_AT` embedded at build time): under
//!   it, the update is `required`.
//!
//! One operation at a time (`pending` is the lock): a check, a download or an
//! install never overlap, and an install asked mid-download waits for it.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::update_state::{progress_step, RequiredReason, UpdateErrorCode, UpdatePhase, UpdateRequirement, UpdateStatus};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What the manifest says beyond the release: the floor under which an
/// update is required.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ManifestFloor {
    pub min_version: Option<String>,
    /// Days; a fraction is allowed (tests of a running app).
    pub max_age_days: Option<f64>,
}

impl ManifestFloor {
    /// Reads `min_version` and `max_age_days` from the raw manifest; a field
    /// of the wrong shape is ignored (logged), never fatal.
    pub fn from_manifest(raw: &serde_json::Value) -> Self {
        let min_version = raw.get("min_version").and_then(|value| value.as_str()).filter(|text| semver::Version::parse(text).is_ok()).map(str::to_string);
        if raw.get("min_version").is_some() && min_version.is_none() {
            log::warn!("manifest min_version ignored: not a version");
        }
        let max_age_days = raw.get("max_age_days").and_then(|value| value.as_f64()).filter(|days| days.is_finite() && *days > 0.0);
        if raw.get("max_age_days").is_some() && max_age_days.is_none() {
            log::warn!("manifest max_age_days ignored: not a positive number");
        }
        Self { min_version, max_age_days }
    }
}

/// A release the feed offers.
#[derive(Debug, Clone)]
pub struct Offer<T> {
    pub version: String,
    /// The minisign signature the manifest announced: a release replaced
    /// under the same number is told apart.
    pub signature: String,
    pub floor: ManifestFloor,
    pub release: T,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FeedFailure {
    Unreachable(String),
    Translocated,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DownloadFailure {
    Signature(String),
    Network(String),
}

pub type Progress = Box<dyn FnMut(usize, Option<u64>) + Send>;

pub trait Feed: Send + Sync + 'static {
    type Release: Clone + Send + Sync + 'static;
    fn check(&self) -> BoxFuture<'_, Result<Option<Offer<Self::Release>>, FeedFailure>>;
    /// Downloads and verifies the signature: the bytes are trusted.
    fn download<'a>(&'a self, release: &'a Self::Release, progress: Progress) -> BoxFuture<'a, Result<Vec<u8>, DownloadFailure>>;
    fn install(&self, release: &Self::Release, bytes: &[u8]) -> Result<(), String>;
}

/// What the shell does around an install.
pub struct InstallHooks {
    /// Right before the bundle is replaced: stops the popup and waits for
    /// its exit. `false` refuses the install.
    pub before_install: Box<dyn Fn() -> BoxFuture<'static, bool> + Send + Sync>,
    /// The popup runs again: the install failed.
    pub resume: Box<dyn Fn() + Send + Sync>,
    /// Installed: restart into the new version.
    pub restart: Box<dyn Fn() + Send + Sync>,
}

/// Whether the idle conditions still hold, read again right before the bundle is replaced.
pub type StillIdle = Arc<dyn Fn() -> bool + Send + Sync>;

#[derive(Clone)]
pub enum InstallTrigger {
    /// The user clicked « Redémarrer » (or « Mettre à jour maintenant »).
    User,
    /// The Mac is idle, no run in progress (`update_idle.rs`). The feed check
    /// may take a while: the user may come back, start a run or turn the
    /// setting off meanwhile, so the conditions are read again once it answers.
    Idle(StillIdle),
}

impl std::fmt::Debug for InstallTrigger {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::User => "User",
            Self::Idle(_) => "Idle",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum InstallRefusal {
    #[error("no update is ready")]
    NotReady,
    /// The feed now offers `version` instead: it downloads, the stale one is dropped.
    #[error("superseded by {version}")]
    Superseded { version: String },
    #[error("the feed no longer offers this version")]
    Withdrawn,
    #[error("the feed could not be read")]
    FeedUnreachable,
    #[error("the popup did not stop")]
    PopupStillRunning,
    #[error("the bundle could not be replaced")]
    InstallFailed,
    /// An idle install whose conditions no longer held once the feed answered: the download is kept.
    #[error("the Mac is no longer idle")]
    NoLongerIdle,
}

/// What the bridge and the idle installer call, whatever the feed.
pub trait UpdateControl: Send + Sync {
    fn check(&self) -> BoxFuture<'_, ()>;
    fn install(&self, expected: String, trigger: InstallTrigger) -> BoxFuture<'_, Result<(), InstallRefusal>>;
}

/// No feed configured: nothing to install, and a check says the feed cannot
/// be read (the "update required" screen then offers the download page).
pub struct NoUpdates(pub Arc<UpdateStatus>);

impl UpdateControl for NoUpdates {
    fn check(&self) -> BoxFuture<'_, ()> {
        log::warn!("update check asked, but no update feed is configured");
        // Through `checking`, like a real check: a screen already showing this
        // error sees the check end instead of waiting on a repeat that is never published.
        self.0.set_phase(UpdatePhase::Checking);
        self.0.failed(UpdateErrorCode::FeedUnreachable, false);
        Box::pin(async {})
    }
    fn install(&self, _: String, _: InstallTrigger) -> BoxFuture<'_, Result<(), InstallRefusal>> {
        Box::pin(async { Err(InstallRefusal::NotReady) })
    }
}

struct Pending<T> {
    version: String,
    signature: String,
    release: T,
    bytes: Vec<u8>,
}

pub struct UpdateEngine<F: Feed> {
    feed: F,
    status: Arc<UpdateStatus>,
    hooks: InstallHooks,
    current: semver::Version,
    /// Unix seconds this build was made, when the build said.
    built_at: Option<u64>,
    /// Unix seconds now, and the same as RFC 3339 (tests set both).
    clock: Box<dyn Fn() -> (u64, String) + Send + Sync>,
    pending: tokio::sync::Mutex<Option<Pending<F::Release>>>,
    /// The release (version, signature) whose signature was refused: never
    /// downloaded again by this process, the error stays until the feed offers
    /// something else.
    refused: std::sync::Mutex<Option<(String, String)>>,
}

const DAY: f64 = 86_400.0;

/// The floor this build is under, if any: the minimum version first, then the build's age.
pub fn manifest_requirement(floor: &ManifestFloor, current: &semver::Version, built_at: Option<u64>, now: u64) -> Option<UpdateRequirement> {
    if let Some(minimum) = &floor.min_version {
        if semver::Version::parse(minimum).is_ok_and(|minimum| *current < minimum) {
            return Some(UpdateRequirement { reason: RequiredReason::MinimumVersion, minimum: Some(minimum.clone()) });
        }
    }
    if let (Some(days), Some(built_at)) = (floor.max_age_days, built_at) {
        if now.saturating_sub(built_at) as f64 > days * DAY {
            return Some(UpdateRequirement { reason: RequiredReason::BuildAge, minimum: None });
        }
    }
    None
}

fn system_clock() -> (u64, String) {
    let now = time::OffsetDateTime::now_utc();
    (now.unix_timestamp().max(0) as u64, now.format(&time::format_description::well_known::Rfc3339).unwrap_or_default())
}

impl<F: Feed> UpdateEngine<F> {
    pub fn new(feed: F, status: Arc<UpdateStatus>, hooks: InstallHooks, current: semver::Version, built_at: Option<u64>) -> Self {
        Self::with_clock(feed, status, hooks, current, built_at, Box::new(system_clock))
    }

    pub fn with_clock(feed: F, status: Arc<UpdateStatus>, hooks: InstallHooks, current: semver::Version, built_at: Option<u64>, clock: Box<dyn Fn() -> (u64, String) + Send + Sync>) -> Self {
        Self { feed, status, hooks, current, built_at, clock, pending: tokio::sync::Mutex::new(None), refused: std::sync::Mutex::new(None) }
    }

    fn failed_check(&self, failure: &FeedFailure, holding: bool) {
        match failure {
            FeedFailure::Translocated => self.status.failed(UpdateErrorCode::Translocated, false),
            FeedFailure::Unreachable(error) => {
                log::error!("update feed unreachable ({error})");
                self.status.failed(UpdateErrorCode::FeedUnreachable, holding);
            }
        }
    }

    /// Checks the feed, then downloads what it offers unless already held.
    pub async fn check_now(&self) {
        let mut pending = self.pending.lock().await;
        if pending.is_none() {
            self.status.set_phase(UpdatePhase::Checking);
        }
        log::info!("checking for updates (current {})", self.current);
        let offer = match self.feed.check().await {
            Ok(offer) => offer,
            Err(failure) => return self.failed_check(&failure, pending.is_some()),
        };
        let (now, stamp) = (self.clock)();
        self.status.checked(stamp);
        let Some(offer) = offer else {
            if let Some(dropped) = pending.take() {
                log::warn!("update {} withdrawn from the feed: dropped", dropped.version);
            } else {
                log::info!("up to date ({})", self.current);
            }
            self.status.set_manifest_requirement(None);
            self.status.set_phase(UpdatePhase::Idle);
            return;
        };
        let requirement = manifest_requirement(&offer.floor, &self.current, self.built_at, now);
        if let Some(requirement) = &requirement {
            log::warn!("update required by the manifest ({:?}, minimum {:?})", requirement.reason, requirement.minimum);
        }
        self.status.set_manifest_requirement(requirement);
        if pending.as_ref().is_some_and(|held| held.version == offer.version && held.signature == offer.signature) {
            return;
        }
        if let Some(dropped) = pending.take() {
            log::info!("update {} superseded by {}: dropped", dropped.version, offer.version);
        }
        let release = (offer.version.clone(), offer.signature.clone());
        if self.refused.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref() == Some(&release) {
            log::warn!("update {} still offered with the refused signature: not downloaded again", offer.version);
            self.status.failed(UpdateErrorCode::SignatureRefused, false);
            return;
        }
        *pending = self.download(offer).await;
    }

    async fn download(&self, offer: Offer<F::Release>) -> Option<Pending<F::Release>> {
        let version = offer.version.clone();
        log::info!("update {version} available (current {}), downloading", self.current);
        self.status.set_phase(UpdatePhase::Available { version: version.clone() });
        let status = self.status.clone();
        let reported = version.clone();
        let mut received: u64 = 0;
        let progress: Progress = Box::new(move |chunk, total| {
            let before = received;
            received += chunk as u64;
            if before == 0 || progress_step(before, received, total) {
                let clamp = |bytes: u64| u32::try_from(bytes).unwrap_or(u32::MAX);
                status.set_phase(UpdatePhase::Downloading { version: reported.clone(), downloaded: clamp(received), total: total.map(clamp) });
            }
        });
        match self.feed.download(&offer.release, progress).await {
            Ok(bytes) => {
                log::info!("update {version} downloaded ({} bytes), signature verified: ready", bytes.len());
                self.status.set_phase(UpdatePhase::Ready { version: version.clone() });
                Some(Pending { version, signature: offer.signature, release: offer.release, bytes })
            }
            Err(DownloadFailure::Signature(error)) => {
                log::error!("update {version} refused: bad signature ({error})");
                *self.refused.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((version, offer.signature));
                self.status.failed(UpdateErrorCode::SignatureRefused, false);
                None
            }
            Err(DownloadFailure::Network(error)) => {
                log::error!("update {version} download failed ({error})");
                self.status.failed(UpdateErrorCode::DownloadFailed, false);
                None
            }
        }
    }

    /// A user's click stands; an idle install holds only while its conditions do.
    fn still_wanted(trigger: &InstallTrigger) -> bool {
        match trigger {
            InstallTrigger::User => true,
            InstallTrigger::Idle(still_idle) => still_idle(),
        }
    }

    /// Installs the held update if it is still `expected` and still offered,
    /// then restarts. Refused otherwise, and the reason says what changed.
    pub async fn install_now(&self, expected: &str, trigger: InstallTrigger) -> Result<(), InstallRefusal> {
        let mut pending = self.pending.lock().await;
        match pending.as_ref() {
            None => return Err(InstallRefusal::NotReady),
            Some(held) if held.version != expected => return Err(InstallRefusal::Superseded { version: held.version.clone() }),
            Some(_) => {}
        }
        log::info!("installing {expected} ({trigger:?}): checking the feed once more");
        let offer = match self.feed.check().await {
            Ok(offer) => offer,
            Err(failure) => {
                self.failed_check(&failure, true);
                return Err(InstallRefusal::FeedUnreachable);
            }
        };
        let held = pending.take().expect("checked above");
        match offer {
            None => {
                log::warn!("update {expected} withdrawn before its install: dropped");
                self.status.set_manifest_requirement(None);
                self.status.set_phase(UpdatePhase::Idle);
                return Err(InstallRefusal::Withdrawn);
            }
            Some(offer) if offer.version != held.version || offer.signature != held.signature => {
                log::warn!("update {expected} superseded by {} before its install: dropped, downloading the new one", offer.version);
                self.status.set_phase(UpdatePhase::Available { version: offer.version.clone() });
                self.status.wake();
                return Err(InstallRefusal::Superseded { version: offer.version });
            }
            Some(_) => {}
        }
        if !Self::still_wanted(&trigger) {
            log::info!("idle install of {expected} called off: the Mac is no longer idle, or a run started");
            *pending = Some(held);
            return Err(InstallRefusal::NoLongerIdle);
        }
        self.status.set_phase(UpdatePhase::Installing { version: held.version.clone() });
        let stopped = (self.hooks.before_install)().await;
        // Stopping the popup may take seconds: an idle install looks again before touching the bundle.
        if stopped && !Self::still_wanted(&trigger) {
            log::info!("idle install of {expected} called off after the popup stopped");
            (self.hooks.resume)();
            self.status.set_phase(UpdatePhase::Ready { version: held.version.clone() });
            *pending = Some(held);
            return Err(InstallRefusal::NoLongerIdle);
        }
        if !stopped {
            log::error!("update {expected} not installed: the popup did not stop");
            (self.hooks.resume)();
            self.status.failed(UpdateErrorCode::PopupStillRunning, true);
            self.status.set_phase(UpdatePhase::Ready { version: held.version.clone() });
            *pending = Some(held);
            return Err(InstallRefusal::PopupStillRunning);
        }
        if let Err(error) = self.feed.install(&held.release, &held.bytes) {
            log::error!("update {expected} not installed ({error}), installed version kept");
            (self.hooks.resume)();
            self.status.failed(UpdateErrorCode::InstallFailed, false);
            return Err(InstallRefusal::InstallFailed);
        }
        log::info!("update {expected} installed ({trigger:?}), restarting");
        (self.hooks.restart)();
        Ok(())
    }
}

impl<F: Feed> UpdateControl for UpdateEngine<F> {
    fn check(&self) -> BoxFuture<'_, ()> {
        Box::pin(self.check_now())
    }
    fn install(&self, expected: String, trigger: InstallTrigger) -> BoxFuture<'_, Result<(), InstallRefusal>> {
        Box::pin(async move { self.install_now(&expected, trigger).await })
    }
}

#[cfg(test)]
#[path = "update_engine/tests.rs"]
mod tests;
