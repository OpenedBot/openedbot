//! Where the self-update stands, for whatever shows it: the console through
//! the typed bridge (`update_state`, `UpdateStateChanged`), the notch through
//! its protocol (`updateState`). The shell's own dialogs are provisional; the
//! states are the contract.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;

/// One state at a time; `Ready` lasts until the restart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum UpdateState {
    /// Up to date, or not checked yet.
    Idle,
    /// The feed offers `version`; the download starts at once.
    Available { version: String },
    /// Bytes received so far; `total` when the feed said it.
    Downloading { version: String, downloaded: u32, total: Option<u32> },
    /// Installed: applied by a restart (`restart_to_update`) or at the next launch.
    Ready { version: String },
    /// The last attempt failed; the installed version is intact.
    Error { code: UpdateErrorCode },
    /// The API refuses this version (426): an update is needed to go on.
    /// `minimum` when the API named it.
    Required { minimum: Option<String> },
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

impl UpdateState {
    /// The notch's word for it, and the version when there is one.
    pub fn summary(&self) -> (&'static str, Option<&str>) {
        match self {
            Self::Idle => ("idle", None),
            Self::Available { version } => ("available", Some(version)),
            Self::Downloading { version, .. } => ("downloading", Some(version)),
            Self::Ready { version } => ("ready", Some(version)),
            Self::Error { .. } => ("error", None),
            Self::Required { minimum } => ("required", minimum.as_deref()),
        }
    }
}

type Publish = Box<dyn Fn(&UpdateState, bool) + Send + Sync>;

pub struct UpdateStatus {
    state: Mutex<UpdateState>,
    /// A check wanted now (`report_update_required`).
    wake: tokio::sync::Notify,
    /// Told every change; `true` when the status itself changed (not only
    /// the download's progress): the notch hears only those.
    publish: Publish,
    restart: Box<dyn Fn() + Send + Sync>,
}

impl UpdateStatus {
    pub fn new(publish: Publish, restart: Box<dyn Fn() + Send + Sync>) -> Self {
        Self { state: Mutex::new(UpdateState::Idle), wake: tokio::sync::Notify::new(), publish, restart }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, UpdateState> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn get(&self) -> UpdateState {
        self.lock().clone()
    }

    pub fn set(&self, next: UpdateState) {
        let status_changed = {
            let mut current = self.lock();
            if *current == next {
                return;
            }
            let changed = current.summary().0 != next.summary().0;
            *current = next.clone();
            changed
        };
        (self.publish)(&next, status_changed);
    }

    /// The feed found nothing newer: back to idle, unless the API said an
    /// update is required (still true: the user must hear it).
    pub fn up_to_date(&self) {
        if !matches!(self.get(), UpdateState::Required { .. }) {
            self.set(UpdateState::Idle);
        }
    }

    /// The API answered 426: say so (unless an update is already on its way)
    /// and check the feed now.
    pub fn required(&self, minimum: Option<String>) {
        if !matches!(self.get(), UpdateState::Downloading { .. } | UpdateState::Ready { .. }) {
            self.set(UpdateState::Required { minimum });
        }
        self.wake.notify_one();
    }

    /// Resolves when a check is wanted before the period ends.
    pub async fn woken(&self) {
        self.wake.notified().await;
    }

    /// Restarts into the installed update; refused unless one is `Ready`.
    pub fn restart(&self) -> bool {
        if !matches!(self.get(), UpdateState::Ready { .. }) {
            return false;
        }
        (self.restart)();
        true
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

    fn status() -> (UpdateStatus, Seen, Arc<Mutex<u32>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let restarts = Arc::new(Mutex::new(0));
        let (log, count) = (seen.clone(), restarts.clone());
        let status = UpdateStatus::new(Box::new(move |state, changed| log.lock().unwrap().push((state.clone(), changed))), Box::new(move || *count.lock().unwrap() += 1));
        (status, seen, restarts)
    }

    #[test]
    fn publishes_each_change_once_and_flags_status_changes() {
        let (status, seen, _) = status();
        status.set(UpdateState::Available { version: "1.1.0".into() });
        status.set(UpdateState::Available { version: "1.1.0".into() });
        status.set(UpdateState::Downloading { version: "1.1.0".into(), downloaded: 10, total: Some(100) });
        status.set(UpdateState::Downloading { version: "1.1.0".into(), downloaded: 50, total: Some(100) });
        status.set(UpdateState::Ready { version: "1.1.0".into() });
        let flags: Vec<bool> = seen.lock().unwrap().iter().map(|(_, changed)| *changed).collect();
        assert_eq!(flags, vec![true, true, false, true], "a repeat is silent, progress is not a status change");
    }

    #[test]
    fn required_stays_until_an_update_arrives_and_wakes_a_check() {
        let (status, _, _) = status();
        status.required(Some("1.1.0".into()));
        assert_eq!(status.get(), UpdateState::Required { minimum: Some("1.1.0".into()) });
        status.up_to_date();
        assert!(matches!(status.get(), UpdateState::Required { .. }), "a feed with nothing newer does not hide it");
        status.set(UpdateState::Ready { version: "1.1.0".into() });
        status.required(None);
        assert!(matches!(status.get(), UpdateState::Ready { .. }), "an installed update is not undone");
        // The wake was stored for the next wait.
        let woken = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap().block_on(async {
            tokio::time::timeout(std::time::Duration::from_millis(50), status.woken()).await.is_ok()
        });
        assert!(woken);
    }

    #[test]
    fn restarts_only_when_ready() {
        let (status, _, restarts) = status();
        assert!(!status.restart());
        status.set(UpdateState::Error { code: UpdateErrorCode::SignatureRefused });
        assert!(!status.restart());
        status.set(UpdateState::Ready { version: "1.1.0".into() });
        assert!(status.restart());
        assert_eq!(*restarts.lock().unwrap(), 1);
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
        let ready = serde_json::to_value(UpdateState::Ready { version: "1.1.0".into() }).unwrap();
        assert_eq!(ready, serde_json::json!({ "status": "ready", "version": "1.1.0" }));
        let error = serde_json::to_value(UpdateState::Error { code: UpdateErrorCode::SignatureRefused }).unwrap();
        assert_eq!(error, serde_json::json!({ "status": "error", "code": "SIGNATURE_REFUSED" }));
    }
}
