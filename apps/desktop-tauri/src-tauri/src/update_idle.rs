//! Installs a ready update while nobody uses the Mac, like Grok's idle
//! install (on by default, Settings › Mises à jour turns it off): the screen
//! is locked, the screensaver runs, or no input came for ten minutes, AND the
//! console sees no run in progress. The engine still checks the feed before
//! installing (`update_engine.rs`): a withdrawn or superseded version is
//! skipped. A required update does not wait for this; it waits for a click.
//!
//! The signals come from macOS (`macos/idle.rs`); elsewhere a stub that is
//! never idle, so nothing installs by itself there.

use std::sync::Arc;
use std::time::Duration;

use crate::update_engine::{InstallRefusal, InstallTrigger, StillIdle, UpdateControl};
use crate::update_state::{UpdateState, UpdateStatus};

/// No input for this long counts as idle (`OPENEDBOT_UPDATE_IDLE_SECONDS` for tests).
pub const IDLE_AFTER: Duration = Duration::from_secs(600);
const MIN_IDLE_AFTER: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_secs(15);
/// After a refused or failed attempt: the feed is not asked again every poll.
const RETRY_AFTER: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct IdleSignal {
    pub locked: bool,
    pub screensaver: bool,
    /// Seconds since the last keyboard, mouse or trackpad event.
    pub idle_seconds: f64,
}

pub trait IdleSource: Send + Sync {
    fn signal(&self) -> IdleSignal;
}

/// Never idle: other systems, and tests.
pub struct NeverIdle;

impl IdleSource for NeverIdle {
    fn signal(&self) -> IdleSignal {
        IdleSignal::default()
    }
}

/// Why the Mac counts as idle, for the journal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdleBecause {
    Locked,
    Screensaver,
    NoInput,
}

pub fn idle_because(signal: IdleSignal, threshold: Duration) -> Option<IdleBecause> {
    if signal.locked {
        Some(IdleBecause::Locked)
    } else if signal.screensaver {
        Some(IdleBecause::Screensaver)
    } else if signal.idle_seconds.is_finite() && signal.idle_seconds >= threshold.as_secs_f64() {
        Some(IdleBecause::NoInput)
    } else {
        None
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdleDecision {
    /// Install this version now.
    Install { version: String, because: IdleBecause },
    Off,
    NothingReady,
    /// The console has not said how many runs are in progress: unknown is busy.
    RunsUnknown,
    RunsBusy(u32),
    InUse,
}

pub fn decide(state: &UpdateState, runs: Option<u32>, signal: IdleSignal, threshold: Duration) -> IdleDecision {
    if !state.auto_install {
        return IdleDecision::Off;
    }
    let Some(version) = state.ready_version() else { return IdleDecision::NothingReady };
    match runs {
        None => return IdleDecision::RunsUnknown,
        Some(busy) if busy > 0 => return IdleDecision::RunsBusy(busy),
        Some(_) => {}
    }
    match idle_because(signal, threshold) {
        Some(because) => IdleDecision::Install { version: version.to_string(), because },
        None => IdleDecision::InUse,
    }
}

/// The conditions of an idle install, apart from the phase: the setting is
/// on, no run is in progress, and nobody uses the Mac. The engine reads them
/// again while it installs (the phase is then `Installing`, no longer `Ready`).
pub fn conditions_hold(state: &UpdateState, runs: Option<u32>, signal: IdleSignal, threshold: Duration) -> bool {
    state.auto_install && runs == Some(0) && idle_because(signal, threshold).is_some()
}

/// What the engine calls back before it replaces the bundle.
pub fn still_idle(status: Arc<UpdateStatus>, idle: Arc<dyn IdleSource>, threshold: Duration) -> StillIdle {
    Arc::new(move || conditions_hold(&status.get(), status.runs(), idle.signal(), threshold))
}

pub fn idle_threshold(raw: Option<&str>) -> Duration {
    raw.and_then(|value| value.trim().parse::<u64>().ok()).map(Duration::from_secs).filter(|after| *after >= MIN_IDLE_AFTER).unwrap_or(IDLE_AFTER)
}

/// Polls the conditions while the app runs.
pub async fn run(status: Arc<UpdateStatus>, control: Arc<dyn UpdateControl>, idle: Arc<dyn IdleSource>, threshold: Duration) {
    let mut last: Option<IdleDecision> = None;
    loop {
        tokio::time::sleep(POLL).await;
        let decision = decide(&status.get(), status.runs(), idle.signal(), threshold);
        if last.as_ref() != Some(&decision) {
            match &decision {
                IdleDecision::RunsBusy(runs) => log::info!("idle install waits: {runs} run(s) in progress"),
                IdleDecision::RunsUnknown => log::info!("idle install waits: the console has not reported its runs"),
                _ => {}
            }
            last = Some(decision.clone());
        }
        let IdleDecision::Install { version, because } = decision else { continue };
        log::info!("the Mac is idle ({because:?}), no run in progress: installing {version}");
        let still = still_idle(status.clone(), idle.clone(), threshold);
        match control.install(version.clone(), InstallTrigger::Idle(still)).await {
            Ok(()) => return,
            Err(InstallRefusal::Superseded { version: newer }) => log::info!("idle install skipped: {version} superseded by {newer}"),
            Err(InstallRefusal::NoLongerIdle) => continue,
            Err(refusal) => log::warn!("idle install of {version} not done ({refusal})"),
        }
        tokio::time::sleep(RETRY_AFTER).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::update_state::UpdatePhase;

    fn state(phase: UpdatePhase, auto_install: bool) -> UpdateState {
        UpdateState { phase, required: None, last_error: None, auto_install, last_check: None }
    }

    fn ready() -> UpdateState {
        state(UpdatePhase::Ready { version: "0.0.17".into() }, true)
    }

    const TEN_MINUTES: Duration = IDLE_AFTER;
    const ACTIVE: IdleSignal = IdleSignal { locked: false, screensaver: false, idle_seconds: 4.0 };

    #[test]
    fn a_run_in_progress_blocks_the_install() {
        let away = IdleSignal { locked: true, ..ACTIVE };
        assert_eq!(decide(&ready(), Some(2), away, TEN_MINUTES), IdleDecision::RunsBusy(2));
        assert_eq!(decide(&ready(), None, away, TEN_MINUTES), IdleDecision::RunsUnknown, "unknown is busy");
        assert_eq!(decide(&ready(), Some(0), away, TEN_MINUTES), IdleDecision::Install { version: "0.0.17".into(), because: IdleBecause::Locked });
    }

    #[test]
    fn a_user_at_the_keyboard_is_never_interrupted() {
        assert_eq!(decide(&ready(), Some(0), ACTIVE, TEN_MINUTES), IdleDecision::InUse);
        let almost = IdleSignal { idle_seconds: 599.0, ..ACTIVE };
        assert_eq!(decide(&ready(), Some(0), almost, TEN_MINUTES), IdleDecision::InUse);
        let away = IdleSignal { idle_seconds: 600.0, ..ACTIVE };
        assert!(matches!(decide(&ready(), Some(0), away, TEN_MINUTES), IdleDecision::Install { because: IdleBecause::NoInput, .. }));
        let saver = IdleSignal { screensaver: true, ..ACTIVE };
        assert!(matches!(decide(&ready(), Some(0), saver, TEN_MINUTES), IdleDecision::Install { because: IdleBecause::Screensaver, .. }));
        let broken = IdleSignal { idle_seconds: f64::NAN, ..ACTIVE };
        assert_eq!(decide(&ready(), Some(0), broken, TEN_MINUTES), IdleDecision::InUse);
    }

    #[test]
    fn only_a_ready_update_with_the_setting_on() {
        let away = IdleSignal { locked: true, ..ACTIVE };
        assert_eq!(decide(&state(UpdatePhase::Ready { version: "0.0.17".into() }, false), Some(0), away, TEN_MINUTES), IdleDecision::Off);
        for phase in [UpdatePhase::Idle, UpdatePhase::Downloading { version: "0.0.17".into(), downloaded: 1, total: None }, UpdatePhase::Installing { version: "0.0.17".into() }] {
            assert_eq!(decide(&state(phase, true), Some(0), away, TEN_MINUTES), IdleDecision::NothingReady);
        }
        assert_eq!(decide(&ready(), Some(0), NeverIdle.signal(), TEN_MINUTES), IdleDecision::InUse, "the stub never installs");
    }

    struct Locked(std::sync::atomic::AtomicBool);
    impl IdleSource for Locked {
        fn signal(&self) -> IdleSignal {
            IdleSignal { locked: self.0.load(std::sync::atomic::Ordering::SeqCst), ..ACTIVE }
        }
    }

    #[test]
    fn the_recheck_holds_through_the_installing_phase() {
        let status = Arc::new(UpdateStatus::new(true, Box::new(|_, _| {})));
        let idle = Arc::new(Locked(std::sync::atomic::AtomicBool::new(true)));
        let still = still_idle(status.clone(), idle.clone(), TEN_MINUTES);
        status.set_phase(UpdatePhase::Installing { version: "0.0.17".into() });
        assert!(!still(), "no run count reported yet");
        status.set_runs(Some(0));
        assert!(still(), "the engine's recheck sees Installing, not Ready: still idle");
        status.set_runs(Some(1));
        assert!(!still(), "a run started");
        status.set_runs(Some(0));
        idle.0.store(false, std::sync::atomic::Ordering::SeqCst);
        assert!(!still(), "the user is back");
        idle.0.store(true, std::sync::atomic::Ordering::SeqCst);
        status.set_auto_install(false);
        assert!(!still(), "the setting was turned off");
    }

    #[tokio::test]
    async fn an_idle_install_through_the_engine_goes_to_the_end() {
        use crate::update_engine::{BoxFuture, DownloadFailure, Feed, FeedFailure, InstallHooks, ManifestFloor, Offer, Progress, UpdateEngine};
        use std::sync::atomic::{AtomicU32, Ordering};
        struct OneRelease;
        impl Feed for OneRelease {
            type Release = ();
            fn check(&self) -> BoxFuture<'_, Result<Option<Offer<()>>, FeedFailure>> {
                Box::pin(async { Ok(Some(Offer { version: "0.0.17".into(), signature: "s".into(), floor: ManifestFloor::default(), release: () })) })
            }
            fn download<'a>(&'a self, _: &'a (), _: Progress) -> BoxFuture<'a, Result<Vec<u8>, DownloadFailure>> {
                Box::pin(async { Ok(vec![1]) })
            }
            fn install(&self, _: &(), _: &[u8]) -> Result<(), String> {
                Ok(())
            }
        }
        let status = Arc::new(UpdateStatus::new(true, Box::new(|_, _| {})));
        let restarts = Arc::new(AtomicU32::new(0));
        let restarted = restarts.clone();
        let hooks = InstallHooks { before_install: Box::new(|| Box::pin(async { true })), resume: Box::new(|| {}), restart: Box::new(move || {
            restarted.fetch_add(1, Ordering::SeqCst);
        }) };
        let engine = UpdateEngine::new(OneRelease, status.clone(), hooks, semver::Version::new(0, 0, 16), None);
        engine.check_now().await;
        status.set_runs(Some(0));
        let idle = Arc::new(Locked(std::sync::atomic::AtomicBool::new(true)));
        let still = still_idle(status.clone(), idle, TEN_MINUTES);
        assert_eq!(engine.install_now("0.0.17", InstallTrigger::Idle(still)).await, Ok(()));
        assert_eq!(restarts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn the_threshold_is_ten_minutes_unless_told_otherwise() {
        assert_eq!(idle_threshold(None), IDLE_AFTER);
        assert_eq!(idle_threshold(Some("20")), Duration::from_secs(20));
        assert_eq!(idle_threshold(Some("2")), IDLE_AFTER, "below the floor");
        assert_eq!(idle_threshold(Some("later")), IDLE_AFTER);
    }
}
