//! Tests of the popup host (`popup.rs`): protocol, life cycle, failures of ADR 0001 section 5.

use super::*;
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicUsize, Ordering};

#[test]
fn parses_the_popup_messages_and_rejects_the_rest() {
    assert_eq!(
        parse_popup_message(r#"{"type":"ready","protocol":1,"version":"1.2.0","extra":true}"#),
        Ok(PopupToHost::Ready { protocol: 1, version: "1.2.0".into() })
    );
    assert_eq!(parse_popup_message(r#"{"type":"token","id":"t-1"}"#), Ok(PopupToHost::Token { id: "t-1".into(), force: false }));
    assert_eq!(parse_popup_message(r#"{"type":"token","id":"bad id"}"#), Err(ParseFailure::InvalidFields));
    assert_eq!(parse_popup_message(r#"{"type":"fatal","code":"lower"}"#), Err(ParseFailure::InvalidFields));
    assert_eq!(parse_popup_message(r#"{"type":"steal"}"#), Err(ParseFailure::UnknownType));
    assert_eq!(parse_popup_message("not json"), Err(ParseFailure::InvalidJson));
    assert_eq!(parse_popup_message(&"x".repeat(MAX_LINE_LENGTH + 1)), Err(ParseFailure::TooLong));
}

#[test]
fn encodes_host_messages_on_one_line() {
    let hello = encode_host_message(&HostToPopup::Hello { protocol: 1, api_origin: "http://127.0.0.1:8790".into(), console_url: "x".into() });
    assert_eq!(hello, "{\"type\":\"hello\",\"protocol\":1,\"apiOrigin\":\"http://127.0.0.1:8790\",\"consoleUrl\":\"x\"}\n");
    let token = encode_host_message(&HostToPopup::Token { id: "a".into(), access_token: None, expires_at: None, organization_id: None, error: Some("unavailable") });
    assert_eq!(token, "{\"type\":\"token\",\"id\":\"a\",\"accessToken\":null,\"expiresAt\":null,\"organizationId\":null,\"error\":\"unavailable\"}\n");
    assert_eq!(encode_host_message(&HostToPopup::SignedIn), "{\"type\":\"signedIn\"}\n");
    let update = encode_host_message(&HostToPopup::UpdateState { status: "ready", version: Some("1.1.0".into()) });
    assert_eq!(update, "{\"type\":\"updateState\",\"status\":\"ready\",\"version\":\"1.1.0\"}\n");
}

#[test]
fn console_paths_stay_plain_and_absolute() {
    assert_eq!(resolve_console_path("/compact/bot-1?x=1#y").as_deref(), Some("/compact/bot-1?x=1#y"));
    for refused in ["", "compact", "//evil.com", "/a\\b", "/a/../b", "/a\nb", "https://evil.com"] {
        assert_eq!(resolve_console_path(refused), None, "{refused:?}");
    }
}

struct Tokens {
    served: AtomicUsize,
}

impl TokenSource for Tokens {
    async fn read_access(&self, _force: bool, _served: Option<String>) -> Result<Option<AccessGrant>, ApiError> {
        self.served.fetch_add(1, Ordering::SeqCst);
        Ok(Some(AccessGrant { access_token: "access".into(), expires_at: "2099-01-01T00:00:00Z".into(), organization_id: Some("org".into()) }))
    }
    fn is_signed_in(&self) -> bool {
        true
    }
    async fn sign_out(&self) {}
}

#[derive(Default)]
struct Events {
    opened: Mutex<Vec<String>>,
    gave_up: Mutex<Vec<GiveUp>>,
}

impl PopupEvents for Events {
    fn open_console(&self, path: &str) {
        self.opened.lock().unwrap().push(path.into());
    }
    fn gave_up(&self, reason: &GiveUp) {
        self.gave_up.lock().unwrap().push(reason.clone());
    }
}

/// A fake popup bundle: a shell script speaking the protocol.
fn fake_bundle(name: &str, protocol: u32, script: &str) -> PathBuf {
    let bundle = std::env::temp_dir().join(format!("openedbot-popup-test-{}-{name}", std::process::id())).join(BUNDLE_NAME);
    std::fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
    std::fs::write(
        bundle.join("Contents/Info.plist"),
        format!("<plist><dict><key>OpenedbotHostedProtocol</key>\n  <integer>{protocol}</integer></dict></plist>"),
    )
    .unwrap();
    let executable = bundle.join(EXECUTABLE);
    std::fs::write(&executable, format!("#!/bin/sh\n{script}\n")).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    bundle
}

#[test]
fn reads_the_declared_protocol() {
    let bundle = fake_bundle("plist", 1, "exit 0");
    assert_eq!(read_hosted_protocol(&bundle), Some(1));
    assert_eq!(read_hosted_protocol(Path::new("/nonexistent")), None);
}

#[tokio::test]
async fn hosts_a_popup_through_ready_hello_and_a_token() {
    // Answers ready, then asks for a token and a console path once it got
    // hello and the session state, then echoes the token reply to a file.
    let out = std::env::temp_dir().join(format!("openedbot-popup-test-{}-out", std::process::id()));
    let script = format!(
        r#"echo '{{"type":"ready","protocol":1,"version":"test"}}'
read hello; read state
echo '{{"type":"token","id":"t1"}}'
echo '{{"type":"openConsole","path":"/compact/bot-1"}}'
echo '{{"type":"openConsole","path":"//evil"}}'
read reply
printf '%s\n%s\n%s\n' "$hello" "$state" "$reply" > '{}'
read eof
exit 0"#,
        out.display()
    );
    let bundle = fake_bundle("happy", 1, &script);
    let tokens = Arc::new(Tokens { served: AtomicUsize::new(0) });
    let events = Arc::new(Events::default());
    let host = PopupHost::new(Some(bundle), "http://127.0.0.1:8790", "http://localhost:1420", tokens.clone(), events.clone());
    host.start();
    for _ in 0..100 {
        if out.exists() && std::fs::read_to_string(&out).unwrap().lines().count() == 3 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let written = std::fs::read_to_string(&out).expect("the fake popup wrote what it received");
    let lines: Vec<&str> = written.lines().collect();
    assert_eq!(lines[0], r#"{"type":"hello","protocol":1,"apiOrigin":"http://127.0.0.1:8790","consoleUrl":"http://localhost:1420"}"#);
    assert_eq!(lines[1], r#"{"type":"signedIn"}"#);
    assert!(lines[2].contains(r#""id":"t1""#) && lines[2].contains(r#""organizationId":"org""#));
    assert_eq!(tokens.served.load(Ordering::SeqCst), 1);
    assert_eq!(*events.opened.lock().unwrap(), vec!["/compact/bot-1".to_string()]);
    host.stop();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(events.gave_up.lock().unwrap().is_empty());
    let _ = std::fs::remove_file(out);
}

#[tokio::test]
async fn an_incompatible_or_missing_bundle_is_given_up_at_once() {
    let events = Arc::new(Events::default());
    let tokens = Arc::new(Tokens { served: AtomicUsize::new(0) });
    let old = fake_bundle("old", 2, "exit 0");
    PopupHost::new(Some(old), "a", "b", tokens.clone(), events.clone()).start();
    PopupHost::new(None, "a", "b", tokens, events.clone()).start();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let reasons = events.gave_up.lock().unwrap().clone();
    assert!(reasons.contains(&GiveUp::Protocol(2)));
    assert!(reasons.contains(&GiveUp::Missing));
}

#[tokio::test]
async fn a_popup_that_refuses_is_not_restarted() {
    let events = Arc::new(Events::default());
    let tokens = Arc::new(Tokens { served: AtomicUsize::new(0) });
    let bundle = fake_bundle("fatal", 1, r#"echo '{"type":"fatal","code":"UNSUPPORTED_OS"}'; sleep 5"#);
    PopupHost::new(Some(bundle), "a", "b", tokens, events.clone()).start();
    for _ in 0..60 {
        if !events.gave_up.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(*events.gave_up.lock().unwrap(), vec![GiveUp::Fatal("UNSUPPORTED_OS".into())]);
}

fn fast_policy() -> Policy {
    Policy {
        ready_timeout: Duration::from_secs(5),
        max_failures: 5,
        restart_base: Duration::from_millis(10),
        restart_cap: Duration::from_millis(40),
        healthy_run: Duration::from_secs(60),
    }
}

#[tokio::test]
async fn a_popup_crashing_in_a_loop_is_restarted_five_times_then_given_up() {
    // Each launch appends a line, then crashes before ready.
    let launches = std::env::temp_dir().join(format!("openedbot-popup-test-{}-launches", std::process::id()));
    let _ = std::fs::remove_file(&launches);
    let bundle = fake_bundle("crash", 1, &format!("echo x >> '{}'\nexit 3", launches.display()));
    let events = Arc::new(Events::default());
    let tokens = Arc::new(Tokens { served: AtomicUsize::new(0) });
    PopupHost::with_policy(Some(bundle), "a", "b", tokens, events.clone(), fast_policy()).start();
    for _ in 0..200 {
        if !events.gave_up.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(*events.gave_up.lock().unwrap(), vec![GiveUp::Crashing(5)]);
    // One launch, then five restarts.
    assert_eq!(std::fs::read_to_string(&launches).unwrap().lines().count(), 6);
    let _ = std::fs::remove_file(launches);
}

#[tokio::test]
async fn stop_and_wait_returns_once_the_process_is_gone() {
    // Ready, then ignores everything: only EOF (or the kill after the grace) ends it.
    let pid_file = std::env::temp_dir().join(format!("openedbot-popup-test-{}-pid", std::process::id()));
    let script = format!(
        "echo $$ > '{}'\necho '{{\"type\":\"ready\",\"protocol\":1,\"version\":\"t\"}}'\nwhile read line; do :; done\nexit 0",
        pid_file.display()
    );
    let bundle = fake_bundle("wait", 1, &script);
    let events = Arc::new(Events::default());
    let tokens = Arc::new(Tokens { served: AtomicUsize::new(0) });
    let host = PopupHost::with_policy(Some(bundle), "a", "b", tokens, events.clone(), fast_policy());
    host.start();
    for _ in 0..100 {
        if *host.running.borrow() > 0 && pid_file.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let pid = std::fs::read_to_string(&pid_file).unwrap().trim().to_string();
    assert!(host.stop_and_wait(Duration::from_secs(5)).await);
    let alive = std::process::Command::new("kill").args(["-0", &pid]).status().unwrap().success();
    assert!(!alive, "the popup process still runs after stop_and_wait");
    // Nothing runs any more: answers at once.
    assert!(host.stop_and_wait(Duration::from_millis(10)).await);
    assert!(events.gave_up.lock().unwrap().is_empty());
    let _ = std::fs::remove_file(pid_file);
}

#[tokio::test]
async fn a_launch_is_claimed_under_the_stop_lock() {
    // `run_once` claims `running` only while the popup is wanted, under the
    // lock `stop` takes: a launch after a stop spawns nothing, and a launch
    // claimed first holds `stop_and_wait` until its process is gone.
    let bundle = fake_bundle("claim", 1, "exit 0");
    // No executable: a launch that tried to spawn would fail, not stop.
    std::fs::remove_file(bundle.join(EXECUTABLE)).unwrap();
    let host = PopupHost::with_policy(Some(bundle.clone()), "a", "b", Arc::new(Tokens { served: AtomicUsize::new(0) }), Arc::new(Events::default()), fast_policy());
    host.stop();
    assert!(matches!(host.run_once(&bundle).await, RunEnd::Stopped), "a stopped popup tried to spawn");
    assert_eq!(*host.running.borrow(), 0);
}

#[tokio::test]
async fn overlapping_runs_keep_the_bundle_busy_until_both_are_gone() {
    // Popup, then Window, then Popup again before the first process exited:
    // the old run ending must not report the new one gone.
    let host = PopupHost::with_policy(None, "a", "b", Arc::new(Tokens { served: AtomicUsize::new(0) }), Arc::new(Events::default()), fast_policy());
    host.running.send_modify(|running| *running += 1);
    host.running.send_modify(|running| *running += 1);
    host.release_run();
    assert!(!host.stop_and_wait(Duration::from_millis(50)).await, "one popup process still runs");
    host.release_run();
    assert!(host.stop_and_wait(Duration::from_millis(50)).await);
    host.release_run();
    assert_eq!(*host.running.borrow(), 0, "never below zero");
}

#[tokio::test]
async fn a_held_popup_does_not_start_until_released() {
    let launches = std::env::temp_dir().join(format!("openedbot-popup-test-{}-held-launches", std::process::id()));
    let _ = std::fs::remove_file(&launches);
    let script = format!("echo x >> '{}'\necho '{{\"type\":\"ready\",\"protocol\":1,\"version\":\"t\"}}'\nwhile read line; do :; done", launches.display());
    let bundle = fake_bundle("held", 1, &script);
    let host = PopupHost::with_policy(Some(bundle), "a", "b", Arc::new(Tokens { served: AtomicUsize::new(0) }), Arc::new(Events::default()), fast_policy());
    assert!(host.hold_and_wait(Duration::from_millis(10)).await);
    // A Dock menu choice while the bundle is replaced.
    host.start();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!launches.exists(), "a held popup was launched");
    assert_eq!(*host.running.borrow(), 0);
    host.release();
    host.start();
    for _ in 0..100 {
        if launches.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(launches.exists(), "a released popup starts again");
    assert!(host.stop_and_wait(Duration::from_secs(5)).await);
    let _ = std::fs::remove_file(launches);
}

#[tokio::test]
async fn a_popup_closed_by_its_user_is_reported_and_not_restarted() {
    let bundle = fake_bundle("quit", 1, r#"echo '{"type":"ready","protocol":1,"version":"t"}'; read hello; exit 0"#);
    #[derive(Default)]
    struct Closed(AtomicUsize);
    impl PopupEvents for Closed {
        fn open_console(&self, _: &str) {}
        fn gave_up(&self, _: &GiveUp) {}
        fn user_closed(&self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    let events = Arc::new(Closed::default());
    let tokens = Arc::new(Tokens { served: AtomicUsize::new(0) });
    PopupHost::with_policy(Some(bundle), "a", "b", tokens, events.clone(), fast_policy()).start();
    for _ in 0..100 {
        if events.0.load(Ordering::SeqCst) > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(events.0.load(Ordering::SeqCst), 1);
}
