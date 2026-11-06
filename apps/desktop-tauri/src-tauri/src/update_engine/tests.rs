use super::*;
use crate::update_state::{UpdateState, UpdateStatus};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

/// One scripted answer of the feed: version, signature, floor.
type Answer = Result<Option<(&'static str, &'static str, ManifestFloor)>, FeedFailure>;

/// A feed that answers from a script, one answer per check.
#[derive(Default)]
struct ScriptedFeed {
    checks: Mutex<VecDeque<Answer>>,
    download_fails: Mutex<Option<DownloadFailure>>,
    install_fails: bool,
    installed: Mutex<Vec<String>>,
    downloads: AtomicU32,
}

impl ScriptedFeed {
    fn answers(answers: Vec<Answer>) -> Self {
        Self { checks: Mutex::new(answers.into()), ..Default::default() }
    }
}

impl Feed for ScriptedFeed {
    type Release = String;
    fn check(&self) -> BoxFuture<'_, Result<Option<Offer<String>>, FeedFailure>> {
        let next = self.checks.lock().unwrap().pop_front().expect("an unscripted check");
        Box::pin(async move {
            next.map(|offer| offer.map(|(version, signature, floor)| Offer { version: version.into(), signature: signature.into(), floor, release: version.into() }))
        })
    }
    fn download<'a>(&'a self, release: &'a String, mut progress: Progress) -> BoxFuture<'a, Result<Vec<u8>, DownloadFailure>> {
        self.downloads.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            if let Some(failure) = self.download_fails.lock().unwrap().take() {
                return Err(failure);
            }
            progress(50, Some(100));
            progress(50, Some(100));
            Ok(release.as_bytes().to_vec())
        })
    }
    fn install(&self, release: &String, bytes: &[u8]) -> Result<(), String> {
        assert_eq!(release.as_bytes(), bytes, "the held bytes are the ones installed");
        if self.install_fails {
            return Err("read-only".into());
        }
        self.installed.lock().unwrap().push(release.clone());
        Ok(())
    }
}

struct Harness {
    engine: UpdateEngine<ScriptedFeed>,
    status: Arc<UpdateStatus>,
    seen: Arc<Mutex<Vec<UpdateState>>>,
    restarts: Arc<AtomicU32>,
    popup_stops: Arc<AtomicU32>,
    resumes: Arc<AtomicU32>,
}

const NOW: u64 = 1_800_000_000;

fn harness(feed: ScriptedFeed, popup_stops_in_time: bool, built_at: Option<u64>) -> Harness {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    let status = Arc::new(UpdateStatus::new(true, Box::new(move |state, _| log.lock().unwrap().push(state.clone()))));
    let restarts = Arc::new(AtomicU32::new(0));
    let popup_stops = Arc::new(AtomicU32::new(0));
    let resumes = Arc::new(AtomicU32::new(0));
    let (restarted, stopped, resumed) = (restarts.clone(), popup_stops.clone(), resumes.clone());
    let hooks = InstallHooks {
        before_install: Box::new(move || {
            stopped.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move { popup_stops_in_time })
        }),
        resume: Box::new(move || {
            resumed.fetch_add(1, Ordering::SeqCst);
        }),
        restart: Box::new(move || {
            restarted.fetch_add(1, Ordering::SeqCst);
        }),
    };
    let engine = UpdateEngine::with_clock(feed, status.clone(), hooks, semver::Version::new(0, 0, 16), built_at, Box::new(|| (NOW, "2027-01-15T08:00:00Z".into())));
    Harness { engine, status, seen, restarts, popup_stops, resumes }
}

fn offer(version: &'static str) -> Answer {
    Ok(Some((version, version, ManifestFloor::default())))
}

fn ready(version: &str) -> UpdatePhase {
    UpdatePhase::Ready { version: version.into() }
}

#[tokio::test]
async fn a_download_is_silent_and_waits_for_consent() {
    let h = harness(ScriptedFeed::answers(vec![offer("0.0.17"), offer("0.0.17")]), true, None);
    h.engine.check_now().await;
    assert_eq!(h.status.phase(), ready("0.0.17"));
    let phases: Vec<&'static str> = h.seen.lock().unwrap().iter().map(|state| state.summary().0).collect();
    assert_eq!(phases.first(), Some(&"checking"));
    assert!(phases.contains(&"available") && phases.contains(&"downloading"));
    // A later check of the same release downloads nothing and installs nothing.
    h.engine.check_now().await;
    assert_eq!(h.status.phase(), ready("0.0.17"));
    assert_eq!((h.restarts.load(Ordering::SeqCst), h.popup_stops.load(Ordering::SeqCst)), (0, 0), "no restart without install");
    assert!(h.engine.feed.installed.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_install_with_the_seen_version_rechecks_then_restarts() {
    let h = harness(ScriptedFeed::answers(vec![offer("0.0.17"), offer("0.0.17")]), true, None);
    h.engine.check_now().await;
    assert_eq!(h.engine.install_now("0.0.17", InstallTrigger::User).await, Ok(()));
    assert_eq!(*h.engine.feed.installed.lock().unwrap(), vec!["0.0.17".to_string()]);
    assert_eq!((h.restarts.load(Ordering::SeqCst), h.popup_stops.load(Ordering::SeqCst)), (1, 1));
    assert!(h.seen.lock().unwrap().iter().any(|state| state.phase == UpdatePhase::Installing { version: "0.0.17".into() }), "the notch hears it before the popup stops");
}

#[tokio::test]
async fn nothing_to_install_before_a_download() {
    let h = harness(ScriptedFeed::answers(vec![]), true, None);
    assert_eq!(h.engine.install_now("0.0.17", InstallTrigger::User).await, Err(InstallRefusal::NotReady));
}

#[tokio::test]
async fn a_superseded_version_is_never_installed() {
    // Seen 0.0.17; at the click the feed offers 0.0.18.
    let h = harness(ScriptedFeed::answers(vec![offer("0.0.17"), offer("0.0.18"), offer("0.0.18")]), true, None);
    h.engine.check_now().await;
    assert_eq!(h.engine.install_now("0.0.17", InstallTrigger::User).await, Err(InstallRefusal::Superseded { version: "0.0.18".into() }));
    assert!(h.engine.feed.installed.lock().unwrap().is_empty());
    assert_eq!(h.status.phase(), UpdatePhase::Available { version: "0.0.18".into() });
    assert_eq!(h.popup_stops.load(Ordering::SeqCst), 0, "the popup keeps running");
    // The next check downloads the new one; the old expected version is refused.
    h.engine.check_now().await;
    assert_eq!(h.status.phase(), ready("0.0.18"));
    assert_eq!(h.engine.install_now("0.0.17", InstallTrigger::User).await, Err(InstallRefusal::Superseded { version: "0.0.18".into() }));
    assert_eq!(h.restarts.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_release_replaced_under_the_same_number_is_superseded() {
    let replaced = Ok(Some(("0.0.17", "another signature", ManifestFloor::default())));
    let h = harness(ScriptedFeed::answers(vec![offer("0.0.17"), replaced]), true, None);
    h.engine.check_now().await;
    assert!(matches!(h.engine.install_now("0.0.17", InstallTrigger::Idle(Arc::new(|| true))).await, Err(InstallRefusal::Superseded { .. })));
    assert!(h.engine.feed.installed.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_withdrawn_version_is_dropped() {
    let h = harness(ScriptedFeed::answers(vec![offer("0.0.17"), Ok(None)]), true, None);
    h.engine.check_now().await;
    assert_eq!(h.engine.install_now("0.0.17", InstallTrigger::Idle(Arc::new(|| true))).await, Err(InstallRefusal::Withdrawn));
    assert_eq!(h.status.phase(), UpdatePhase::Idle);
    assert_eq!(h.engine.install_now("0.0.17", InstallTrigger::User).await, Err(InstallRefusal::NotReady));
}

#[tokio::test]
async fn an_unreachable_feed_refuses_the_install_and_keeps_the_download() {
    let h = harness(ScriptedFeed::answers(vec![offer("0.0.17"), Err(FeedFailure::Unreachable("offline".into())), offer("0.0.17")]), true, None);
    h.engine.check_now().await;
    assert_eq!(h.engine.install_now("0.0.17", InstallTrigger::User).await, Err(InstallRefusal::FeedUnreachable));
    let state = h.status.get();
    assert_eq!(state.phase, ready("0.0.17"));
    assert_eq!(state.last_error, Some(UpdateErrorCode::FeedUnreachable));
    assert_eq!(h.engine.install_now("0.0.17", InstallTrigger::User).await, Ok(()));
}

#[tokio::test]
async fn a_popup_that_does_not_stop_keeps_the_update_ready() {
    let h = harness(ScriptedFeed::answers(vec![offer("0.0.17"), offer("0.0.17")]), false, None);
    h.engine.check_now().await;
    assert_eq!(h.engine.install_now("0.0.17", InstallTrigger::User).await, Err(InstallRefusal::PopupStillRunning));
    assert_eq!(h.status.phase(), ready("0.0.17"));
    assert_eq!(h.status.get().last_error, Some(UpdateErrorCode::PopupStillRunning));
    assert_eq!(h.restarts.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_failed_install_restarts_nothing() {
    let mut feed = ScriptedFeed::answers(vec![offer("0.0.17"), offer("0.0.17")]);
    feed.install_fails = true;
    let h = harness(feed, true, None);
    h.engine.check_now().await;
    assert_eq!(h.engine.install_now("0.0.17", InstallTrigger::User).await, Err(InstallRefusal::InstallFailed));
    assert_eq!(h.status.phase(), UpdatePhase::Error { code: UpdateErrorCode::InstallFailed });
    assert_eq!(h.restarts.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_bad_signature_holds_nothing() {
    let feed = ScriptedFeed::answers(vec![offer("0.0.17")]);
    *feed.download_fails.lock().unwrap() = Some(DownloadFailure::Signature("other key".into()));
    let h = harness(feed, true, None);
    h.engine.check_now().await;
    assert_eq!(h.status.phase(), UpdatePhase::Error { code: UpdateErrorCode::SignatureRefused });
    assert_eq!(h.engine.install_now("0.0.17", InstallTrigger::User).await, Err(InstallRefusal::NotReady));
}

/// Seen on the signed 0.0.19 (D2c): each check downloaded the forged 20 MB
/// again, and the error left Réglages as soon as the feed answered.
#[tokio::test]
async fn a_refused_release_is_not_downloaded_again_until_the_feed_changes() {
    let resigned = Ok(Some(("0.0.17", "the right signature", ManifestFloor::default())));
    let feed = ScriptedFeed::answers(vec![offer("0.0.17"), offer("0.0.17"), resigned]);
    *feed.download_fails.lock().unwrap() = Some(DownloadFailure::Signature("other key".into()));
    let h = harness(feed, true, None);
    h.engine.check_now().await;
    h.engine.check_now().await;
    assert_eq!(h.engine.feed.downloads.load(Ordering::SeqCst), 1, "the refused artifact is fetched once");
    let state = h.status.get();
    assert_eq!(state.phase, UpdatePhase::Error { code: UpdateErrorCode::SignatureRefused });
    assert_eq!(state.last_error, Some(UpdateErrorCode::SignatureRefused), "the error stays visible");
    h.engine.check_now().await;
    assert_eq!(h.status.phase(), ready("0.0.17"), "the same number signed again downloads");
}

#[tokio::test]
async fn the_manifest_floor_requires_the_update() {
    let floor = ManifestFloor { min_version: Some("0.0.17".into()), max_age_days: None };
    let h = harness(ScriptedFeed::answers(vec![Ok(Some(("0.0.18", "s", floor))), Ok(Some(("0.0.18", "s", ManifestFloor::default())))]), true, None);
    h.engine.check_now().await;
    assert_eq!(h.status.get().required, Some(UpdateRequirement { reason: RequiredReason::MinimumVersion, minimum: Some("0.0.17".into()) }));
    // The floor is read again at each check: lifted, the requirement goes.
    h.engine.check_now().await;
    assert_eq!(h.status.get().required, None);
}

#[tokio::test]
async fn an_old_build_is_required_to_update() {
    let floor = ManifestFloor { min_version: None, max_age_days: Some(30.0) };
    let built = NOW - 31 * 86_400;
    let h = harness(ScriptedFeed::answers(vec![Ok(Some(("0.0.18", "s", floor)))]), true, Some(built));
    h.engine.check_now().await;
    assert_eq!(h.status.get().required, Some(UpdateRequirement { reason: RequiredReason::BuildAge, minimum: None }));
}

#[test]
fn the_floor_rules() {
    let current = semver::Version::new(1, 2, 0);
    let floor = |min: Option<&str>, days: Option<f64>| ManifestFloor { min_version: min.map(str::to_string), max_age_days: days };
    assert_eq!(manifest_requirement(&floor(Some("1.2.0"), None), &current, None, NOW), None, "equal to the floor is fine");
    assert_eq!(manifest_requirement(&floor(Some("1.3.0"), None), &current, None, NOW).unwrap().reason, RequiredReason::MinimumVersion);
    assert_eq!(manifest_requirement(&floor(None, Some(1.0)), &current, None, NOW), None, "no build time: no age rule");
    assert_eq!(manifest_requirement(&floor(None, Some(1.0)), &current, Some(NOW - 3_600), NOW), None);
    assert_eq!(manifest_requirement(&floor(None, Some(0.001)), &current, Some(NOW - 3_600), NOW).unwrap().reason, RequiredReason::BuildAge);
    assert_eq!(manifest_requirement(&floor(None, Some(1.0)), &current, Some(NOW + 10), NOW), None, "a clock behind the build is not an old build");
}

#[test]
fn the_floor_is_read_from_the_raw_manifest() {
    let raw = serde_json::json!({ "version": "1.3.0", "min_version": "1.1.0", "max_age_days": 45 });
    assert_eq!(ManifestFloor::from_manifest(&raw), ManifestFloor { min_version: Some("1.1.0".into()), max_age_days: Some(45.0) });
    let odd = serde_json::json!({ "version": "1.3.0", "min_version": "soon", "max_age_days": -3 });
    assert_eq!(ManifestFloor::from_manifest(&odd), ManifestFloor::default());
    assert_eq!(ManifestFloor::from_manifest(&serde_json::json!({ "version": "1.3.0" })), ManifestFloor::default());
}

#[tokio::test]
async fn a_failed_check_without_a_download_says_error() {
    let h = harness(ScriptedFeed::answers(vec![Err(FeedFailure::Unreachable("dns".into())), Err(FeedFailure::Translocated)]), true, None);
    h.engine.check_now().await;
    assert_eq!(h.status.phase(), UpdatePhase::Error { code: UpdateErrorCode::FeedUnreachable });
    h.engine.check_now().await;
    assert_eq!(h.status.phase(), UpdatePhase::Error { code: UpdateErrorCode::Translocated });
}

#[tokio::test]
async fn an_idle_install_called_off_while_the_feed_answered_keeps_the_download() {
    let h = harness(ScriptedFeed::answers(vec![offer("0.0.17"), offer("0.0.17"), offer("0.0.17")]), true, None);
    h.engine.check_now().await;
    let back = InstallTrigger::Idle(Arc::new(|| false));
    assert_eq!(h.engine.install_now("0.0.17", back).await, Err(InstallRefusal::NoLongerIdle));
    assert_eq!(h.status.phase(), ready("0.0.17"));
    assert_eq!((h.restarts.load(Ordering::SeqCst), h.popup_stops.load(Ordering::SeqCst)), (0, 0), "nothing stopped, nothing restarted");
    assert_eq!(h.engine.install_now("0.0.17", InstallTrigger::Idle(Arc::new(|| true))).await, Ok(()));
}

#[tokio::test]
async fn an_idle_install_called_off_while_the_popup_stopped_resumes_it() {
    let h = harness(ScriptedFeed::answers(vec![offer("0.0.17"), offer("0.0.17")]), true, None);
    h.engine.check_now().await;
    // Idle when the feed answers, back at the keyboard once the popup has stopped.
    let asked = Arc::new(AtomicU32::new(0));
    let counter = asked.clone();
    let back = InstallTrigger::Idle(Arc::new(move || counter.fetch_add(1, Ordering::SeqCst) == 0));
    assert_eq!(h.engine.install_now("0.0.17", back).await, Err(InstallRefusal::NoLongerIdle));
    assert_eq!((h.popup_stops.load(Ordering::SeqCst), h.resumes.load(Ordering::SeqCst)), (1, 1), "stopped, then started again");
    assert_eq!(h.restarts.load(Ordering::SeqCst), 0);
    assert!(h.engine.feed.installed.lock().unwrap().is_empty(), "the bundle was not touched");
    assert_eq!(h.status.phase(), ready("0.0.17"));
}
