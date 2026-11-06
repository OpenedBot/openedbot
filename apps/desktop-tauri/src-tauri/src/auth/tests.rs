//! Tests of the native session (`auth.rs`).

use super::*;
use crate::vault::VaultError;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};

fn tokens(access: &str, refresh: &str, expires_in_secs: i64) -> NativeTokens {
    NativeTokens {
        access_token: access.into(),
        access_token_expires_at: (OffsetDateTime::now_utc() + time::Duration::seconds(expires_in_secs)).format(&Rfc3339).unwrap(),
        refresh_token: refresh.into(),
        organization_id: Some("org-1".into()),
    }
}

/// A scripted API: answers in order, counts calls, can stall.
#[derive(Default)]
struct FakeApi {
    answers: Mutex<VecDeque<Result<Value, ApiError>>>,
    calls: Mutex<Vec<String>>,
    refreshes: AtomicUsize,
    delay_ms: u64,
    logout_fails: bool,
}

impl FakeApi {
    fn answering(answers: Vec<Result<Value, ApiError>>) -> Self {
        Self { answers: Mutex::new(answers.into()), ..Self::default() }
    }
}

impl AuthApi for Arc<FakeApi> {
    async fn post_json(&self, path: &str, body: Value) -> Result<Value, ApiError> {
        self.calls.lock().unwrap().push(path.to_string());
        if body.get("grantType").and_then(Value::as_str) == Some("refresh_token") {
            self.refreshes.fetch_add(1, Ordering::SeqCst);
        }
        if self.delay_ms > 0 {
            tokio::time::sleep(Duration::from_millis(self.delay_ms)).await;
        }
        self.answers.lock().unwrap().pop_front().unwrap_or_else(|| Err(ApiError::network()))
    }

    async fn logout(&self, _access_token: &str) -> Result<(), ApiError> {
        self.calls.lock().unwrap().push("/api/auth/logout".into());
        if self.logout_fails {
            Err(ApiError::network())
        } else {
            Ok(())
        }
    }
}

/// A keystore that may refuse; records what it was given.
#[derive(Default)]
struct FakeVault {
    stored: Mutex<Option<String>>,
    broken: bool,
}

impl Vault for Arc<FakeVault> {
    fn load(&self) -> Result<Option<String>, VaultError> {
        if self.broken {
            return Err(VaultError("locked".into()));
        }
        Ok(self.stored.lock().unwrap().clone())
    }
    fn save(&self, secret: &str) -> Result<(), VaultError> {
        if self.broken {
            return Err(VaultError("locked".into()));
        }
        *self.stored.lock().unwrap() = Some(secret.into());
        Ok(())
    }
    fn clear(&self) -> Result<(), VaultError> {
        if self.broken {
            return Err(VaultError("locked".into()));
        }
        *self.stored.lock().unwrap() = None;
        Ok(())
    }
}

#[derive(Default)]
struct Recorder {
    states: Mutex<Vec<SigninState>>,
    signed_in: AtomicUsize,
    signed_out: Mutex<Vec<SignedOutReason>>,
}

impl AuthEvents for Recorder {
    fn signin_state(&self, state: &SigninState) {
        self.states.lock().unwrap().push(state.clone());
    }
    fn signed_in(&self) {
        self.signed_in.fetch_add(1, Ordering::SeqCst);
    }
    fn signed_out(&self, reason: SignedOutReason) {
        self.signed_out.lock().unwrap().push(reason);
    }
}

type Service = AuthService<Arc<FakeApi>, Arc<FakeVault>>;

fn service(api: Arc<FakeApi>, vault: Arc<FakeVault>) -> (Arc<Service>, Arc<Recorder>) {
    let events = Arc::new(Recorder::default());
    let service = AuthService::new(api, vault, events.clone(), "http://127.0.0.1:47813/callback", "test-client");
    (Arc::new(service), events)
}

fn signed_in_with(vault: &Arc<FakeVault>, value: &NativeTokens) {
    *vault.stored.lock().unwrap() = Some(serde_json::to_string(value).unwrap());
}

#[tokio::test]
async fn concurrent_refreshes_rotate_once() {
    let api = Arc::new(FakeApi {
        delay_ms: 50,
        ..FakeApi::answering(vec![Ok(serde_json::to_value(tokens("access-2", "refresh-2", 900)).unwrap())])
    });
    let vault = Arc::new(FakeVault::default());
    signed_in_with(&vault, &tokens("access-1", "refresh-1", 900));
    let (auth, _) = service(api.clone(), vault.clone());
    assert!(auth.restore());

    let mut tasks = Vec::new();
    for _ in 0..8 {
        let auth = auth.clone();
        tasks.push(tokio::spawn(async move { auth.refresh().await }));
    }
    for task in tasks {
        assert_eq!(task.await.unwrap().unwrap().as_deref(), Some("access-2"));
    }
    assert_eq!(api.refreshes.load(Ordering::SeqCst), 1, "one rotation for eight callers");
    let persisted: NativeTokens = serde_json::from_str(vault.stored.lock().unwrap().as_deref().unwrap()).unwrap();
    assert_eq!(persisted.refresh_token, "refresh-2");
}

#[tokio::test]
async fn an_expiring_token_is_refreshed_on_read_and_a_fresh_one_is_not() {
    let api = Arc::new(FakeApi::answering(vec![Ok(serde_json::to_value(tokens("access-2", "refresh-2", 900)).unwrap())]));
    let vault = Arc::new(FakeVault::default());
    signed_in_with(&vault, &tokens("access-1", "refresh-1", 30));
    let (auth, _) = service(api.clone(), vault);
    auth.restore();
    assert_eq!(auth.read_access_token().await.unwrap().as_deref(), Some("access-2"));
    assert_eq!(auth.read_access_token().await.unwrap().as_deref(), Some("access-2"));
    assert_eq!(api.refreshes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_transient_failure_keeps_a_token_that_is_still_alive() {
    let api = Arc::new(FakeApi::answering(vec![Err(ApiError { status: 503, code: "DOWN".into() })]));
    let vault = Arc::new(FakeVault::default());
    signed_in_with(&vault, &tokens("access-1", "refresh-1", 30));
    let (auth, events) = service(api, vault);
    auth.restore();
    assert_eq!(auth.read_access_token().await.unwrap().as_deref(), Some("access-1"));
    assert!(auth.is_signed_in());
    assert!(events.signed_out.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_refused_refresh_loses_the_session() {
    let api = Arc::new(FakeApi::answering(vec![Err(ApiError { status: 401, code: "REFRESH_INVALID".into() })]));
    let vault = Arc::new(FakeVault::default());
    signed_in_with(&vault, &tokens("access-1", "refresh-1", 900));
    let (auth, events) = service(api, vault.clone());
    auth.restore();
    assert_eq!(auth.refresh().await.unwrap(), None);
    assert!(!auth.is_signed_in());
    assert_eq!(*events.signed_out.lock().unwrap(), vec![SignedOutReason::SessionLost]);
    assert!(vault.stored.lock().unwrap().is_none());
}

#[tokio::test]
async fn without_a_keystore_the_session_lives_in_memory_only() {
    let api = Arc::new(FakeApi::answering(vec![
        Ok(json!({ "code": "auth-code" })),
        Ok(serde_json::to_value(tokens("access-1", "refresh-1", 900)).unwrap()),
    ]));
    let vault = Arc::new(FakeVault { broken: true, ..FakeVault::default() });
    let (auth, events) = service(api, vault.clone());
    assert!(!auth.restore());
    assert_eq!(auth.persistence(), Persistence::MemoryOnly);

    auth.verify_email_code("dev@ohb.local".into(), "123456".into()).await;
    assert_eq!(events.signed_in.load(Ordering::SeqCst), 1);
    assert_eq!(auth.read_access_token().await.unwrap().as_deref(), Some("access-1"));
    // Nothing reached any storage: the vault refused, and there is no file fallback.
    assert!(vault.stored.lock().unwrap().is_none());
}

#[tokio::test]
async fn a_keystore_that_fails_on_save_switches_to_memory_only() {
    let api = Arc::new(FakeApi::answering(vec![
        Ok(json!({ "code": "auth-code" })),
        Ok(serde_json::to_value(tokens("access-1", "refresh-1", 900)).unwrap()),
    ]));
    // Loads fine (nothing stored), then refuses to write.
    struct WriteRefused;
    impl Vault for WriteRefused {
        fn load(&self) -> Result<Option<String>, VaultError> {
            Ok(None)
        }
        fn save(&self, _: &str) -> Result<(), VaultError> {
            Err(VaultError("user denied".into()))
        }
        fn clear(&self) -> Result<(), VaultError> {
            Ok(())
        }
    }
    let events = Arc::new(Recorder::default());
    let auth = AuthService::new(api, WriteRefused, events, "http://127.0.0.1:47813/callback", "test");
    auth.restore();
    auth.verify_email_code("dev@ohb.local".into(), "123456".into()).await;
    assert_eq!(auth.persistence(), Persistence::MemoryOnly);
    assert_eq!(auth.read_access_token().await.unwrap().as_deref(), Some("access-1"));
}

#[tokio::test]
async fn the_code_flow_reports_its_states_and_sends_pkce() {
    let api = Arc::new(FakeApi::answering(vec![
        Ok(json!({ "ok": true })),
        Err(ApiError { status: 400, code: "EMAIL_LOGIN_CODE_INVALID".into() }),
    ]));
    let (auth, events) = service(api.clone(), Arc::new(FakeVault::default()));
    auth.request_email_code("dev@ohb.local".into(), "fr".into()).await;
    auth.verify_email_code("dev@ohb.local".into(), "000000".into()).await;
    let states = events.states.lock().unwrap().clone();
    assert_eq!(states[0], SigninState::Sending);
    assert_eq!(states[1], SigninState::CodeSent { email: "dev@ohb.local".into() });
    assert_eq!(states[2], SigninState::Verifying);
    assert!(matches!(&states[3], SigninState::Error { code, .. } if code == "EMAIL_LOGIN_CODE_INVALID"));
    assert_eq!(*api.calls.lock().unwrap(), vec!["/api/auth/login/code", "/api/auth/native/code/verify"]);
    assert!(!auth.is_signed_in());
}

#[tokio::test]
async fn a_cancelled_attempt_cannot_sign_in_late() {
    let api = Arc::new(FakeApi {
        delay_ms: 50,
        ..FakeApi::answering(vec![
            Ok(json!({ "code": "auth-code" })),
            Ok(serde_json::to_value(tokens("access-1", "refresh-1", 900)).unwrap()),
        ])
    });
    let (auth, events) = service(api, Arc::new(FakeVault::default()));
    let verifying = {
        let auth = auth.clone();
        tokio::spawn(async move { auth.verify_email_code("dev@ohb.local".into(), "123456".into()).await })
    };
    tokio::time::sleep(Duration::from_millis(10)).await;
    auth.cancel_sign_in();
    verifying.await.unwrap();
    assert!(!auth.is_signed_in());
    assert_eq!(events.signed_in.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn sign_out_clears_locally_even_when_revocation_fails() {
    let api = Arc::new(FakeApi { logout_fails: true, ..FakeApi::default() });
    let vault = Arc::new(FakeVault::default());
    signed_in_with(&vault, &tokens("access-1", "refresh-1", 900));
    let (auth, events) = service(api, vault.clone());
    auth.restore();
    let result = auth.sign_out().await;
    assert!(result.revocation_failed);
    assert!(!auth.is_signed_in());
    assert!(vault.stored.lock().unwrap().is_none());
    assert_eq!(*events.signed_out.lock().unwrap(), vec![SignedOutReason::SignedOut]);
}

#[tokio::test]
async fn a_forced_popup_read_reuses_a_token_rotated_since_it_was_served() {
    let api = Arc::new(FakeApi::default());
    let vault = Arc::new(FakeVault::default());
    signed_in_with(&vault, &tokens("access-2", "refresh-2", 900));
    let (auth, _) = service(api.clone(), vault);
    auth.restore();
    let grant = auth.read_access(true, Some("access-1".into())).await.unwrap().unwrap();
    assert_eq!(grant.access_token, "access-2");
    assert_eq!(api.refreshes.load(Ordering::SeqCst), 0);
}

#[test]
fn pkce_is_43_chars_and_derived_by_sha256() {
    let (verifier, challenge) = create_pkce();
    assert_eq!(verifier.len(), 43);
    assert_eq!(challenge, URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())));
}

#[test]
fn tokens_never_print() {
    let printed = format!("{:?}", tokens("secret-access", "secret-refresh", 900));
    assert!(!printed.contains("secret"));
}

#[tokio::test]
async fn sign_out_happens_locally_even_when_the_api_is_unreachable() {
    // Revocation and refresh both fail on the network: the local session still goes.
    let api = Arc::new(FakeApi { logout_fails: true, ..FakeApi::default() });
    let vault = Arc::new(FakeVault::default());
    signed_in_with(&vault, &tokens("access-1", "refresh-1", 30));
    let (auth, events) = service(api, vault.clone());
    auth.restore();
    assert!(auth.sign_out().await.revocation_failed);
    assert!(!auth.is_signed_in());
    assert!(vault.stored.lock().unwrap().is_none());
    assert_eq!(*events.signed_out.lock().unwrap(), vec![SignedOutReason::SignedOut]);
}

#[tokio::test]
async fn the_proactive_refresh_rotates_a_token_due_and_waits_for_the_next() {
    let api = Arc::new(FakeApi::answering(vec![Ok(serde_json::to_value(tokens("access-2", "refresh-2", 900)).unwrap())]));
    let vault = Arc::new(FakeVault::default());
    signed_in_with(&vault, &tokens("access-1", "refresh-1", 30));
    let (auth, _) = service(api.clone(), vault);
    auth.restore();
    let task = tokio::spawn(auth.clone().keep_fresh());
    for _ in 0..50 {
        if api.refreshes.load(Ordering::SeqCst) > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    // Rotated once, then idle until shortly before the new expiry.
    assert_eq!(api.refreshes.load(Ordering::SeqCst), 1);
    assert_eq!(auth.read_access_token().await.unwrap().as_deref(), Some("access-2"));
    task.abort();
}

#[tokio::test(start_paused = true)]
async fn a_failed_proactive_refresh_is_retried_later_not_in_a_loop() {
    let api = Arc::new(FakeApi::answering(vec![
        Err(ApiError { status: 503, code: "DOWN".into() }),
        Ok(serde_json::to_value(tokens("access-2", "refresh-2", 900)).unwrap()),
    ]));
    let vault = Arc::new(FakeVault::default());
    signed_in_with(&vault, &tokens("access-1", "refresh-1", 45));
    let (auth, _) = service(api.clone(), vault);
    auth.restore();
    let task = tokio::spawn(auth.clone().keep_fresh());
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(api.refreshes.load(Ordering::SeqCst), 1, "one attempt, then a pause");
    tokio::time::sleep(TRANSIENT_REFRESH_RETRY).await;
    assert_eq!(api.refreshes.load(Ordering::SeqCst), 2);
    assert_eq!(auth.read_access_token().await.unwrap().as_deref(), Some("access-2"));
    task.abort();
}

/// A browser and a loopback listener that only record.
#[derive(Default)]
struct FakeGoogle {
    opened: Mutex<Vec<String>>,
    loopback_busy: bool,
    loopback: Mutex<Vec<String>>,
}

impl GoogleSteps for FakeGoogle {
    fn start_loopback(&self, attempt: u64) -> Result<(), StepFailed> {
        self.loopback.lock().unwrap().push(format!("start {attempt}"));
        if self.loopback_busy {
            Err(StepFailed)
        } else {
            Ok(())
        }
    }
    fn stop_loopback(&self, attempt: u64) {
        self.loopback.lock().unwrap().push(format!("stop {attempt}"));
    }
    fn open_browser(&self, url: &url::Url) -> Result<(), StepFailed> {
        self.opened.lock().unwrap().push(url.to_string());
        Ok(())
    }
}

fn targets() -> AuthorizeTargets {
    AuthorizeTargets { api_origin: "http://127.0.0.1:8790".into(), console_origin: "https://console.openedbot.app".into() }
}

const FAST: GoogleTiming = GoogleTiming { poll: Duration::from_millis(5), timeout: Duration::from_secs(5) };

fn started() -> Result<Value, ApiError> {
    Ok(json!({ "attemptId": "attempt-1", "authorizeUrl": "https://accounts.google.com/o/oauth2/v2/auth?client_id=x" }))
}

#[tokio::test]
async fn google_polls_the_claim_until_done_then_signs_in() {
    let api = Arc::new(FakeApi::answering(vec![
        started(),
        Ok(json!({ "status": "pending" })),
        Err(ApiError::network()),
        Ok(json!({ "status": "done", "code": "auth-code" })),
        Ok(serde_json::to_value(tokens("access-g", "refresh-g", 900)).unwrap()),
    ]));
    let (auth, events) = service(api.clone(), Arc::new(FakeVault::default()));
    let google = FakeGoogle::default();
    auth.sign_in_with_google(&google, &targets(), "client", FAST).await;
    assert!(auth.is_signed_in());
    assert_eq!(events.signed_in.load(Ordering::SeqCst), 1);
    assert_eq!(google.opened.lock().unwrap().len(), 1);
    assert_eq!(
        *api.calls.lock().unwrap(),
        vec![
            "/api/auth/native/google/start",
            "/api/auth/native/google/claim",
            "/api/auth/native/google/claim",
            "/api/auth/native/google/claim",
            "/api/auth/native/token"
        ]
    );
    assert_eq!(events.states.lock().unwrap()[0], SigninState::Waiting);
    // The loopback listener is released once the attempt ends.
    assert_eq!(*google.loopback.lock().unwrap(), vec!["start 1", "stop 1"]);
}

#[tokio::test]
async fn google_reports_a_refusal_by_its_code() {
    let api = Arc::new(FakeApi::answering(vec![started(), Ok(json!({ "status": "failed", "code": "AUTH_EMAIL_NOT_VERIFIED" }))]));
    let (auth, events) = service(api, Arc::new(FakeVault::default()));
    auth.sign_in_with_google(&FakeGoogle::default(), &targets(), "client", FAST).await;
    assert!(!auth.is_signed_in());
    let last = events.states.lock().unwrap().last().cloned().unwrap();
    assert!(matches!(last, SigninState::Error { ref code, .. } if code == "AUTH_EMAIL_NOT_VERIFIED"), "{last:?}");
}

#[tokio::test]
async fn google_refuses_an_unexpected_authorize_url_and_a_busy_port() {
    let api = Arc::new(FakeApi::answering(vec![Ok(json!({ "attemptId": "a", "authorizeUrl": "https://evil.example/login" }))]));
    let (auth, events) = service(api, Arc::new(FakeVault::default()));
    let google = FakeGoogle::default();
    auth.sign_in_with_google(&google, &targets(), "client", FAST).await;
    assert!(google.opened.lock().unwrap().is_empty(), "the browser never opens an unexpected page");
    assert!(matches!(events.states.lock().unwrap().last(), Some(SigninState::Error { code, .. }) if code == "AUTHORIZE_URL_UNEXPECTED"));

    let api = Arc::new(FakeApi::default());
    let (auth, events) = service(api.clone(), Arc::new(FakeVault::default()));
    auth.sign_in_with_google(&FakeGoogle { loopback_busy: true, ..FakeGoogle::default() }, &targets(), "client", FAST).await;
    assert!(matches!(events.states.lock().unwrap().last(), Some(SigninState::Error { code, .. }) if code == "LOOPBACK_BUSY"));
    assert!(api.calls.lock().unwrap().is_empty(), "nothing is started without a way back");
}

#[tokio::test]
async fn google_times_out_and_a_cancel_stops_the_polling_silently() {
    let pending = || Ok(json!({ "status": "pending" }));
    let api = Arc::new(FakeApi::answering(vec![started(), pending(), pending(), pending(), pending(), pending(), pending()]));
    let (auth, events) = service(api, Arc::new(FakeVault::default()));
    auth.sign_in_with_google(&FakeGoogle::default(), &targets(), "client", GoogleTiming { poll: Duration::from_millis(5), timeout: Duration::from_millis(20) }).await;
    assert!(matches!(events.states.lock().unwrap().last(), Some(SigninState::Error { code, .. }) if code == "TIMEOUT"));

    let api = Arc::new(FakeApi::answering((0..200).map(|index| if index == 0 { started() } else { pending() }).collect()));
    let (auth, events) = service(api, Arc::new(FakeVault::default()));
    let google = Arc::new(FakeGoogle::default());
    let attempt = {
        let (auth, google) = (auth.clone(), google.clone());
        tokio::spawn(async move { auth.sign_in_with_google(google.as_ref(), &targets(), "client", GoogleTiming { poll: Duration::from_secs(60), timeout: Duration::from_secs(600) }).await })
    };
    tokio::time::sleep(Duration::from_millis(20)).await;
    auth.cancel_sign_in();
    // The cancel wakes the minute-long pause at once.
    tokio::time::timeout(Duration::from_secs(2), attempt).await.expect("cancel stops the attempt").unwrap();
    assert!(!auth.is_signed_in());
    assert_eq!(events.states.lock().unwrap().last(), Some(&SigninState::Idle { reason: None }));
}

#[tokio::test]
async fn the_browser_return_polls_at_once() {
    let api = Arc::new(FakeApi::answering(vec![
        started(),
        Ok(json!({ "status": "done", "code": "auth-code" })),
        Ok(serde_json::to_value(tokens("access-g", "refresh-g", 900)).unwrap()),
    ]));
    let (auth, _) = service(api, Arc::new(FakeVault::default()));
    let attempt = {
        let auth = auth.clone();
        tokio::spawn(async move { auth.sign_in_with_google(&FakeGoogle::default(), &targets(), "client", GoogleTiming { poll: Duration::from_secs(60), timeout: Duration::from_secs(600) }).await })
    };
    tokio::time::sleep(Duration::from_millis(20)).await;
    auth.nudge();
    tokio::time::timeout(Duration::from_secs(2), attempt).await.expect("the nudge triggers the claim").unwrap();
    assert!(auth.is_signed_in());
}

#[test]
fn authorize_urls_stay_on_google_the_api_or_the_console() {
    let targets = targets();
    assert!(targets.check("https://accounts.google.com/o/oauth2/v2/auth?x=1").is_some());
    assert!(targets.check("http://127.0.0.1:8790/api/auth/google/x").is_some());
    assert!(targets.check("https://console.openedbot.app/login").is_some());
    for refused in ["http://accounts.google.com/", "https://evil.example/", "https://accounts.google.com.evil.example/", "javascript:alert(1)", "https://u:p@accounts.google.com/"] {
        assert!(targets.check(refused).is_none(), "{refused}");
    }
}
