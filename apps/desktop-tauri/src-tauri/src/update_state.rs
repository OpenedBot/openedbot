//! Where the self-update stands, for whatever shows it: the console through
//! the typed bridge (`update_state`, `UpdateStateChanged`: the pill, the
//! account menu row, Settings › Mises à jour, the "update required" screen),
//! the notch through its protocol (`updateState`), the app menu's label.
//!
//! Two things are tracked apart: the `phase` of the update itself (checked,
//! downloaded, installing) and whether an update is `required`. Either the
//! API refused this version (426, `report_update_required`) or the manifest
//! sets a floor this build is under (`min_version`, `max_age_days`,
//! `update_engine.rs`). A required update still downloads and installs
//! through the same phases.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;

/// The update's own progress. `Ready` holds a verified download, not yet
/// installed: nothing touches the bundle before the user's consent (or the
/// idle conditions, `update_idle.rs`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum UpdatePhase {
    /// Up to date, or not checked yet.
    Idle,
    /// A check of the feed runs (no update downloaded yet).
    Checking,
    /// The feed offers `version`; the download starts at once.
    Available { version: String },
    /// Bytes received so far; `total` when the feed said it.
    Downloading { version: String, downloaded: u32, total: Option<u32> },
    /// Downloaded and its signature verified: installed by a restart the
    /// user agreed to (`install_update`) or when the Mac is idle.
    Ready { version: String },
    /// Consent given: the feed is checked once more, the popup stopped, the
    /// bundle replaced, then the app restarts.
    Installing { version: String },
    /// The last attempt failed and nothing is downloaded; the installed version is intact.
    Error { code: UpdateErrorCode },
}

/// Why an attempt failed, without detail (the journal has it).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum UpdateErrorCode {
    /// The feed could not be read (network, status, malformed manifest).
    FeedUnreachable,
    /// The artifact could not be downloaded.
    DownloadFailed,
    /// The artifact's signature is not the update key's: nothing was written.
    SignatureRefused,
    /// The notch popup did not exit in time: the bundle was left alone.
    PopupStillRunning,
    /// Replacing the bundle failed.
    InstallFailed,
    /// macOS runs this copy from a read-only place: move it to Applications.
    Translocated,
}

/// Who says an update is required.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum RequiredReason {
    /// The API answered 426 (`DESKTOP_MIN_VERSION`).
    Api,
    /// The manifest's `min_version` is above this version.
    MinimumVersion,
    /// This build is older than the manifest's `max_age_days`.
    BuildAge,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRequirement {
    pub reason: RequiredReason,
    /// The minimum version, when the source named one.
    pub minimum: Option<String>,
}

/// What the console reads (`update_state`) and is pushed on every change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub phase: UpdatePhase,
    /// Set, the console replaces the app with the "update required" screen.
    pub required: Option<UpdateRequirement>,
    /// The last failure, kept for Settings › Mises à jour even once a later
    /// phase replaced it; cleared by the next successful check.
    pub last_error: Option<UpdateErrorCode>,
    /// Installs a ready update when the Mac is idle (preferences, on by default).
    pub auto_install: bool,
    /// When the feed last answered (RFC 3339), `null` before.
    pub last_check: Option<String>,
}

impl UpdateState {
    /// The notch's word for it and the version it names: `required` wins
    /// over the phase (the notch shows a dot for `ready` and `required`).
    pub fn summary(&self) -> (&'static str, Option<String>) {
        if let Some(required) = &self.required {
            return ("required", required.minimum.clone().or_else(|| self.ready_version().map(str::to_string)));
        }
        match &self.phase {
            UpdatePhase::Idle => ("idle", None),
            UpdatePhase::Checking => ("checking", None),
            UpdatePhase::Available { version } => ("available", Some(version.clone())),
            UpdatePhase::Downloading { version, .. } => ("downloading", Some(version.clone())),
            UpdatePhase::Ready { version } => ("ready", Some(version.clone())),
            UpdatePhase::Installing { version } => ("installing", Some(version.clone())),
            UpdatePhase::Error { .. } => ("error", None),
        }
    }

    pub fn ready_version(&self) -> Option<&str> {
        match &self.phase {
            UpdatePhase::Ready { version } => Some(version),
            _ => None,
        }
    }
}

/// Told every change; `true` when the summary changed (not only the
/// download's progress or a setting): the notch and the menu hear only those.
type Publish = Box<dyn Fn(&UpdateState, bool) + Send + Sync>;

struct Inner {
    phase: UpdatePhase,
    /// The API's 426: stays until the app restarts.
    api_required: Option<Option<String>>,
    /// The manifest's floor, read again at every successful check.
    manifest_required: Option<UpdateRequirement>,
    last_error: Option<UpdateErrorCode>,
    auto_install: bool,
    last_check: Option<String>,
    /// Runs the console sees in progress; `None` until it said.
    runs: Option<u32>,
}

impl Inner {
    fn view(&self) -> UpdateState {
        let required = match &self.api_required {
            Some(minimum) => Some(UpdateRequirement { reason: RequiredReason::Api, minimum: minimum.clone() }),
            None => self.manifest_required.clone(),
        };
        UpdateState { phase: self.phase.clone(), required, last_error: self.last_error, auto_install: self.auto_install, last_check: self.last_check.clone() }
    }
}

pub struct UpdateStatus {
    inner: Mutex<Inner>,
    /// A check wanted now (API 426, wake from sleep, a superseded install).
    wake: tokio::sync::Notify,
    publish: Publish,
}

impl UpdateStatus {
    pub fn new(auto_install: bool, publish: Publish) -> Self {
        Self {
            inner: Mutex::new(Inner { phase: UpdatePhase::Idle, api_required: None, manifest_required: None, last_error: None, auto_install, last_check: None, runs: None }),
            wake: tokio::sync::Notify::new(),
            publish,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn get(&self) -> UpdateState {
        self.lock().view()
    }

    pub fn phase(&self) -> UpdatePhase {
        self.lock().phase.clone()
    }

    /// Changes what `change` touches and publishes the result if it differs.
    fn change(&self, change: impl FnOnce(&mut Inner)) {
        let (next, summary_changed) = {
            let mut inner = self.lock();
            let before = inner.view();
            change(&mut inner);
            let after = inner.view();
            if after == before {
                return;
            }
            let changed = after.summary() != before.summary();
            (after, changed)
        };
        (self.publish)(&next, summary_changed);
    }

    pub fn set_phase(&self, phase: UpdatePhase) {
        self.change(|inner| inner.phase = phase);
    }

    /// A failure. With a verified download still held (`keep` true: a later
    /// check failed, the update is still good), the phase stays and only the
    /// error is remembered.
    pub fn failed(&self, code: UpdateErrorCode, keep: bool) {
        self.change(|inner| {
            inner.last_error = Some(code);
            if !keep {
                inner.phase = UpdatePhase::Error { code };
            }
        });
    }

    /// The feed answered: the last error is behind us.
    pub fn checked(&self, at: String) {
        self.change(|inner| {
            inner.last_error = None;
            inner.last_check = Some(at);
        });
    }

    pub fn set_manifest_requirement(&self, requirement: Option<UpdateRequirement>) {
        self.change(|inner| inner.manifest_required = requirement);
    }

    /// The API answered 426: say so and check the feed now.
    pub fn required_by_api(&self, minimum: Option<String>) {
        self.change(|inner| inner.api_required = Some(minimum));
        self.wake.notify_one();
    }

    pub fn set_auto_install(&self, enabled: bool) {
        self.change(|inner| inner.auto_install = enabled);
    }

    /// The runs the console sees in progress, `None` when it cannot tell (not
    /// published: only the idle installer reads it).
    pub fn set_runs(&self, count: Option<u32>) {
        self.lock().runs = count;
    }

    pub fn runs(&self) -> Option<u32> {
        self.lock().runs
    }

    pub fn wake(&self) {
        self.wake.notify_one();
    }

    /// Resolves when a check is wanted before the period ends.
    pub async fn woken(&self) {
        self.wake.notified().await;
    }
}

/// The download's progress, published when the whole percent moves (or, with
/// no total, every 256 KiB): enough for a progress ring, not an event flood.
pub fn progress_step(previous: u64, downloaded: u64, total: Option<u64>) -> bool {
    match total {
        Some(total) if total > 0 => previous * 100 / total != downloaded * 100 / total,
        _ => previous / (256 * 1024) != downloaded / (256 * 1024),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    type Seen = Arc<Mutex<Vec<(UpdateState, bool)>>>;

    fn status() -> (UpdateStatus, Seen) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let status = UpdateStatus::new(true, Box::new(move |state, changed| log.lock().unwrap().push((state.clone(), changed))));
        (status, seen)
    }

    #[test]
    fn publishes_each_change_once_and_flags_summary_changes() {
        let (status, seen) = status();
        status.set_phase(UpdatePhase::Available { version: "1.1.0".into() });
        status.set_phase(UpdatePhase::Available { version: "1.1.0".into() });
        status.set_phase(UpdatePhase::Downloading { version: "1.1.0".into(), downloaded: 10, total: Some(100) });
        status.set_phase(UpdatePhase::Downloading { version: "1.1.0".into(), downloaded: 50, total: Some(100) });
        status.set_phase(UpdatePhase::Ready { version: "1.1.0".into() });
        status.set_auto_install(false);
        let flags: Vec<bool> = seen.lock().unwrap().iter().map(|(_, changed)| *changed).collect();
        assert_eq!(flags, vec![true, true, false, true, false], "a repeat is silent; progress and settings are not summary changes");
    }

    #[test]
    fn the_api_requirement_stays_and_wins_over_the_manifest() {
        let (status, _) = status();
        status.set_manifest_requirement(Some(UpdateRequirement { reason: RequiredReason::BuildAge, minimum: None }));
        assert_eq!(status.get().required.unwrap().reason, RequiredReason::BuildAge);
        status.required_by_api(Some("1.1.0".into()));
        status.set_manifest_requirement(None);
        assert_eq!(status.get().required, Some(UpdateRequirement { reason: RequiredReason::Api, minimum: Some("1.1.0".into()) }));
        let woken = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap().block_on(async {
            tokio::time::timeout(std::time::Duration::from_millis(50), status.woken()).await.is_ok()
        });
        assert!(woken, "a 426 checks the feed at once");
    }

    #[test]
    fn a_failure_keeps_a_held_download() {
        let (status, _) = status();
        status.set_phase(UpdatePhase::Ready { version: "1.1.0".into() });
        status.failed(UpdateErrorCode::FeedUnreachable, true);
        let state = status.get();
        assert_eq!(state.phase, UpdatePhase::Ready { version: "1.1.0".into() });
        assert_eq!(state.last_error, Some(UpdateErrorCode::FeedUnreachable));
        status.checked("2026-11-06T12:00:00Z".into());
        assert_eq!(status.get().last_error, None);
        status.failed(UpdateErrorCode::DownloadFailed, false);
        assert_eq!(status.get().phase, UpdatePhase::Error { code: UpdateErrorCode::DownloadFailed });
    }

    #[test]
    fn the_notch_hears_required_before_the_phase() {
        let (status, _) = status();
        status.set_phase(UpdatePhase::Ready { version: "1.2.0".into() });
        assert_eq!(status.get().summary(), ("ready", Some("1.2.0".into())));
        status.required_by_api(None);
        assert_eq!(status.get().summary(), ("required", Some("1.2.0".into())));
        status.set_phase(UpdatePhase::Installing { version: "1.2.0".into() });
        assert_eq!(status.get().summary(), ("required", None));
    }

    #[test]
    fn progress_moves_by_whole_percents() {
        assert!(!progress_step(0, 5, Some(1000)));
        assert!(progress_step(5, 10, Some(1000)));
        assert!(progress_step(0, 300 * 1024, None));
        assert!(!progress_step(0, 100, None));
    }

    #[test]
    fn serializes_for_the_console() {
        let (status, _) = status();
        status.set_phase(UpdatePhase::Ready { version: "1.1.0".into() });
        status.required_by_api(Some("1.1.0".into()));
        let value = serde_json::to_value(status.get()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "phase": { "status": "ready", "version": "1.1.0" },
                "required": { "reason": "api", "minimum": "1.1.0" },
                "lastError": null,
                "autoInstall": true,
                "lastCheck": null,
            })
        );
        let error = serde_json::to_value(UpdatePhase::Error { code: UpdateErrorCode::SignatureRefused }).unwrap();
        assert_eq!(error, serde_json::json!({ "status": "error", "code": "SIGNATURE_REFUSED" }));
    }
}
