//! The native session: e-mail code sign-in (PKCE), single-flight refresh,
//! sign-out. Port of the Electron shell's `apps/desktop/src/main/auth.ts`,
//! reduced to what the D2a prototype proves (no Google, no password door, no
//! proactive refresh timer: a token is refreshed when read near its expiry).
//!
//! The access token stays here and is handed out on request only
//! (`read_access_token`); the refresh token never leaves this module, except
//! to the keystore.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::vault::Vault;

/// Refresh this long before expiry so a request in flight never carries a
/// token that dies on the way (same margin as Electron).
const REFRESH_MARGIN: Duration = Duration::from_secs(60);

/// Shape of `POST /api/auth/native/token` responses.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTokens {
    pub access_token: String,
    pub access_token_expires_at: String,
    pub refresh_token: String,
    pub organization_id: Option<String>,
}

impl std::fmt::Debug for NativeTokens {
    // Never print a token, even in a test failure.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativeTokens").field("access_token_expires_at", &self.access_token_expires_at).finish_non_exhaustive()
    }
}

/// An API refusal (`status` > 0) or a transport failure (`status` 0).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("API {status} {code}")]
pub struct ApiError {
    pub status: u16,
    pub code: String,
}

impl ApiError {
    pub fn network() -> Self {
        Self { status: 0, code: "NETWORK".into() }
    }
}

/// The sign-in states pushed to the console's `/login` (`NativeSigninState`
/// of `apps/console/src/lib/platform/native-bridge.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SigninState {
    Idle {
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<SignedOutReason>,
    },
    Sending,
    CodeSent {
        email: String,
    },
    Verifying,
    Waiting,
    Error {
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum SignedOutReason {
    SignedOut,
    SessionLost,
}

/// What the shell does when the session starts or ends (navigate the window,
/// tell the popup). Called outside any lock.
pub trait AuthEvents: Send + Sync + 'static {
    fn signin_state(&self, state: &SigninState);
    fn signed_in(&self);
    fn signed_out(&self, reason: SignedOutReason);
}

/// The HTTP side, injectable for tests.
pub trait AuthApi: Send + Sync + 'static {
    fn post_json(&self, path: &str, body: Value) -> impl Future<Output = Result<Value, ApiError>> + Send;
    /// `POST /api/auth/logout` with this bearer; a 401 counts as done.
    fn logout(&self, access_token: &str) -> impl Future<Output = Result<(), ApiError>> + Send;
}

/// What a consumer other than the console (the notch popup) gets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessGrant {
    pub access_token: String,
    pub expires_at: String,
    pub organization_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum Persistence {
    /// The session is in the keystore and survives a restart.
    Keystore,
    /// The keystore refused: the session lives in memory only.
    MemoryOnly,
}

pub struct AuthService<A: AuthApi, V: Vault> {
    api: A,
    vault: V,
    events: Arc<dyn AuthEvents>,
    redirect_uri: String,
    client_id: String,
    inner: Mutex<Inner>,
    /// One rotation at a time: the server revokes the old refresh token on
    /// use, so two parallel refreshes would make the loser look like a lost
    /// session.
    refresh_lock: tokio::sync::Mutex<()>,
}

struct Inner {
    tokens: Option<NativeTokens>,
    /// Bumped on every sign-in and sign-out: an answer for an older session
    /// must never resurrect it.
    generation: u64,
    /// Bumped on every sign-in attempt and cancel: a late answer for a
    /// dropped attempt is ignored.
    attempt: u64,
    persistence: Persistence,
    last_state: SigninState,
}

fn lock(mutex: &Mutex<Inner>) -> MutexGuard<'_, Inner> {
    // A panic while holding the lock leaves plain data behind, still coherent.
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// User-facing failure: a code the console translates, and a French fallback.
fn failure(error: &ApiError) -> SigninState {
    let message = match error.code.as_str() {
        "EMAIL_LOGIN_CODE_INVALID" => "Code invalide ou expiré. Demandez un nouveau code.",
        "EMAIL_LOGIN_CODE_COOLDOWN" => "Patientez une minute avant de demander un nouveau code.",
        "EMAIL_LOGIN_CODE_UNSENT" => "Le code n’a pas pu être envoyé. Réessayez.",
        "RATE_LIMITED" => "Trop de tentatives : patientez une minute.",
        "REDIRECT_URI_INVALID" => "Cette version de l’application n’est pas autorisée par le serveur.",
        "AUTH_EMAIL_NOT_ALLOWED" => "Cette adresse n’est pas encore ouverte sur openedbot.",
        _ if error.status == 0 => "La connexion a échoué. Vérifiez votre réseau puis réessayez.",
        _ if error.status >= 500 => "Le service est indisponible. Réessayez dans un instant.",
        _ => "La connexion a échoué. Réessayez, et prévenez le support si cela se reproduit.",
    };
    // A transport failure or a 5xx is never a refusal of the credentials.
    let code = if error.status == 0 || error.status >= 500 {
        "SERVICE_UNAVAILABLE".to_string()
    } else {
        error.code.clone()
    };
    SigninState::Error { code, message: message.into() }
}

pub fn create_pkce() -> (String, String) {
    // 32 random bytes -> 43 base64url chars, the minimum the API accepts.
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

fn parse_tokens(value: Value) -> Result<NativeTokens, ApiError> {
    serde_json::from_value(value).map_err(|_| ApiError { status: 502, code: "BAD_TOKEN_RESPONSE".into() })
}

/// Time left before the access token expires; an unreadable date counts as
/// already expired (refresh rather than trust it).
fn remaining(tokens: &NativeTokens, now: OffsetDateTime) -> Option<Duration> {
    let expires = OffsetDateTime::parse(&tokens.access_token_expires_at, &Rfc3339).ok()?;
    let left = expires - now;
    (left.is_positive()).then(|| left.unsigned_abs())
}

fn fresh(tokens: &NativeTokens) -> bool {
    remaining(tokens, OffsetDateTime::now_utc()).is_some_and(|left| left > REFRESH_MARGIN)
}

fn alive(tokens: &NativeTokens) -> bool {
    remaining(tokens, OffsetDateTime::now_utc()).is_some()
}

impl<A: AuthApi, V: Vault> AuthService<A, V> {
    pub fn new(api: A, vault: V, events: Arc<dyn AuthEvents>, redirect_uri: &str, client_id: &str) -> Self {
        Self {
            api,
            vault,
            events,
            redirect_uri: redirect_uri.into(),
            client_id: client_id.into(),
            inner: Mutex::new(Inner {
                tokens: None,
                generation: 0,
                attempt: 0,
                persistence: Persistence::Keystore,
                last_state: SigninState::Idle { reason: None },
            }),
            refresh_lock: tokio::sync::Mutex::new(()),
        }
    }

    /// Loads the persisted session, if any. A keystore that refuses leaves the
    /// app signed out, in memory-only mode.
    pub fn restore(&self) -> bool {
        let loaded = match self.vault.load() {
            Ok(Some(secret)) => match serde_json::from_str::<NativeTokens>(&secret) {
                Ok(tokens) => Some(tokens),
                Err(_) => {
                    log::warn!("keystore session has an unexpected shape, discarding it");
                    let _ = self.vault.clear();
                    None
                }
            },
            Ok(None) => None,
            Err(error) => {
                log::warn!("{error}: session kept in memory only");
                lock(&self.inner).persistence = Persistence::MemoryOnly;
                None
            }
        };
        let mut inner = lock(&self.inner);
        inner.tokens = loaded;
        inner.tokens.is_some()
    }

    pub fn is_signed_in(&self) -> bool {
        lock(&self.inner).tokens.is_some()
    }

    pub fn persistence(&self) -> Persistence {
        lock(&self.inner).persistence
    }

    pub fn signin_state(&self) -> SigninState {
        lock(&self.inner).last_state.clone()
    }

    fn report(&self, state: SigninState) {
        lock(&self.inner).last_state = state.clone();
        self.events.signin_state(&state);
    }

    /// Memory first: the rotated refresh token is the only valid one now, so
    /// even if persisting fails the running session must use it.
    fn store_tokens(&self, inner: &mut Inner, next: NativeTokens) {
        let serialized = serde_json::to_string(&next).expect("tokens serialize");
        inner.tokens = Some(next);
        if inner.persistence == Persistence::MemoryOnly {
            return;
        }
        if let Err(error) = self.vault.save(&serialized) {
            log::warn!("{error}: session kept in memory only, nothing persisted");
            inner.persistence = Persistence::MemoryOnly;
        }
    }

    fn drop_session(&self, reason: SignedOutReason) {
        {
            let mut inner = lock(&self.inner);
            inner.tokens = None;
            inner.generation += 1;
            inner.last_state = SigninState::Idle { reason: Some(reason) };
        }
        if let Err(error) = self.vault.clear() {
            log::warn!("{error}: could not clear the stored session");
        }
        self.events.signin_state(&SigninState::Idle { reason: Some(reason) });
        self.events.signed_out(reason);
    }

    /// The current access token, refreshed when it is about to expire.
    /// `Ok(None)` when signed out.
    pub async fn read_access_token(&self) -> Result<Option<String>, ApiError> {
        let current = lock(&self.inner).tokens.clone();
        let Some(tokens) = current else { return Ok(None) };
        if fresh(&tokens) {
            return Ok(Some(tokens.access_token));
        }
        match self.refresh_from(Some(tokens.access_token.clone())).await {
            Ok(token) => Ok(token),
            Err(error) => {
                // Transient failure: a token still inside its real lifetime beats an error.
                let still = lock(&self.inner).tokens.clone();
                match still {
                    Some(tokens) if alive(&tokens) => Ok(Some(tokens.access_token)),
                    _ => Err(error),
                }
            }
        }
    }

    /// Forces a rotation, unless another caller rotated the token while this
    /// one waited: then the fresh token is returned and nothing is spent.
    pub async fn refresh(&self) -> Result<Option<String>, ApiError> {
        let seen = lock(&self.inner).tokens.as_ref().map(|tokens| tokens.access_token.clone());
        self.refresh_from(seen).await
    }

    /// The single-flight rotation. `seen` is the access token the caller
    /// judged stale; if the session no longer holds it, someone else already
    /// rotated and the current token is the answer.
    async fn refresh_from(&self, seen: Option<String>) -> Result<Option<String>, ApiError> {
        let _rotation = self.refresh_lock.lock().await;
        let (generation, used) = {
            let inner = lock(&self.inner);
            match &inner.tokens {
                None => return Ok(None),
                Some(tokens) if Some(&tokens.access_token) != seen.as_ref() => return Ok(Some(tokens.access_token.clone())),
                Some(tokens) => (inner.generation, tokens.clone()),
            }
        };
        let answer = self
            .api
            .post_json("/api/auth/native/token", json!({ "grantType": "refresh_token", "refreshToken": used.refresh_token }))
            .await;
        match answer.and_then(parse_tokens) {
            Ok(next) => {
                let mut inner = lock(&self.inner);
                // Signed out (or re-signed in) while the request was in
                // flight: the answer belongs to a dead session.
                if inner.generation != generation {
                    return Ok(inner.tokens.as_ref().map(|tokens| tokens.access_token.clone()));
                }
                let access = next.access_token.clone();
                self.store_tokens(&mut inner, next);
                Ok(Some(access))
            }
            Err(error) if error.status == 401 => {
                let same = lock(&self.inner).generation == generation;
                if same {
                    self.drop_session(SignedOutReason::SessionLost);
                }
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    /// The token for the popup (`token` message of the popup protocol). A
    /// forced read rotates only if the token the popup holds is still the
    /// current one.
    pub async fn read_access(&self, force: bool, served: Option<String>) -> Result<Option<AccessGrant>, ApiError> {
        let token = if force {
            let seen = served.or_else(|| lock(&self.inner).tokens.as_ref().map(|tokens| tokens.access_token.clone()));
            self.refresh_from(seen).await?
        } else {
            self.read_access_token().await?
        };
        let inner = lock(&self.inner);
        Ok(match (token, &inner.tokens) {
            (Some(_), Some(tokens)) => Some(AccessGrant {
                access_token: tokens.access_token.clone(),
                expires_at: tokens.access_token_expires_at.clone(),
                organization_id: tokens.organization_id.clone(),
            }),
            _ => None,
        })
    }

    fn begin_attempt(&self) -> u64 {
        let mut inner = lock(&self.inner);
        inner.attempt += 1;
        inner.attempt
    }

    fn attempt_current(&self, attempt: u64) -> bool {
        lock(&self.inner).attempt == attempt
    }

    /// E-mail code, step one: `POST /api/auth/login/code`, the same request as
    /// the web `/login`. States: sending, then code_sent or error.
    pub async fn request_email_code(&self, email: String, locale: String) {
        let attempt = self.begin_attempt();
        self.report(SigninState::Sending);
        let outcome = self.api.post_json("/api/auth/login/code", json!({ "email": email, "locale": locale })).await;
        if !self.attempt_current(attempt) {
            return;
        }
        match outcome {
            Ok(_) => self.report(SigninState::CodeSent { email }),
            Err(error) => {
                log::warn!("e-mail code request failed ({error})");
                self.report(failure(&error));
            }
        }
    }

    /// E-mail code, step two: the API checks the code and hands back a PKCE
    /// authorization code, exchanged for the tokens. States: verifying, then
    /// error, or `signed_in` (the shell replaces the page).
    pub async fn verify_email_code(&self, email: String, code: String) {
        let attempt = self.begin_attempt();
        self.report(SigninState::Verifying);
        let (verifier, challenge) = create_pkce();
        let outcome = async {
            let verified = self
                .api
                .post_json(
                    "/api/auth/native/code/verify",
                    json!({
                        "email": email,
                        "code": code,
                        "codeChallenge": challenge,
                        "redirectUri": self.redirect_uri,
                        "clientId": self.client_id,
                    }),
                )
                .await?;
            let authorization = verified
                .get("code")
                .and_then(Value::as_str)
                .ok_or(ApiError { status: 502, code: "BAD_RESPONSE".into() })?
                .to_string();
            self.api
                .post_json(
                    "/api/auth/native/token",
                    json!({
                        "grantType": "authorization_code",
                        "code": authorization,
                        "codeVerifier": verifier,
                        "redirectUri": self.redirect_uri,
                    }),
                )
                .await
                .and_then(parse_tokens)
        }
        .await;
        if !self.attempt_current(attempt) {
            return;
        }
        match outcome {
            Ok(tokens) => {
                {
                    // Checked again under the lock that stores the tokens: a
                    // cancel or sign-out landing after the check above must
                    // not be undone by this late answer.
                    let mut inner = lock(&self.inner);
                    if inner.attempt != attempt {
                        return;
                    }
                    inner.generation += 1;
                    self.store_tokens(&mut inner, tokens);
                }
                self.report(SigninState::Idle { reason: None });
                self.events.signed_in();
            }
            Err(error) => {
                log::warn!("e-mail code sign-in failed ({error})");
                self.report(failure(&error));
            }
        }
    }

    /// Drops the attempt in progress and goes back to idle.
    pub fn cancel_sign_in(&self) {
        self.begin_attempt();
        self.report(SigninState::Idle { reason: None });
    }

    /// Revokes the session on the API, then forgets it locally. The local
    /// part always happens: a failed revocation is logged and reported,
    /// never swallowed.
    pub async fn sign_out(&self) -> SignOutResult {
        self.begin_attempt();
        // An expired access token is refreshed first so the API still
        // recognises the session it must revoke. A failure here is not fatal:
        // the revocation below reports it.
        let _ = self.read_access_token().await;
        // A rotation in flight would replace the session being revoked, and
        // the replacement would survive: let it land first, and keep the lock
        // so no new one starts before the session is gone.
        let _rotation = self.refresh_lock.lock().await;
        let access = lock(&self.inner).tokens.as_ref().map(|tokens| tokens.access_token.clone());
        let revocation = match access {
            Some(token) => self.api.logout(&token).await,
            None => Ok(()),
        };
        let revocation_failed = match revocation {
            Ok(()) => false,
            Err(error) => {
                log::error!("sign-out could not revoke the server session ({error}), local session cleared anyway");
                true
            }
        };
        self.drop_session(SignedOutReason::SignedOut);
        SignOutResult { revocation_failed }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SignOutResult {
    pub revocation_failed: bool,
}

/// The real HTTP side: reqwest against the configured API origin.
pub struct HttpAuthApi {
    client: reqwest::Client,
    api_origin: String,
    client_header: String,
}

impl HttpAuthApi {
    pub fn new(api_origin: &str, version: &str) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .expect("HTTP client");
        Self { client, api_origin: api_origin.into(), client_header: format!("desktop/{version}") }
    }
}

impl AuthApi for HttpAuthApi {
    async fn post_json(&self, path: &str, body: Value) -> Result<Value, ApiError> {
        let response = self
            .client
            .post(format!("{}{}", self.api_origin, path))
            .header("Accept", "application/json")
            .header("X-OpenedBot-Client", &self.client_header)
            .json(&body)
            .send()
            .await
            .map_err(|_| ApiError::network())?;
        let status = response.status();
        let payload: Value = response.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            let code = payload
                .get("error")
                .and_then(|error| error.get("code"))
                .and_then(Value::as_str)
                .unwrap_or("API_ERROR")
                .to_string();
            return Err(ApiError { status: status.as_u16(), code });
        }
        Ok(payload)
    }

    async fn logout(&self, access_token: &str) -> Result<(), ApiError> {
        let response = self
            .client
            .post(format!("{}/api/auth/logout", self.api_origin))
            .bearer_auth(access_token)
            .header("Accept", "application/json")
            .header("X-OpenedBot-Client", &self.client_header)
            .send()
            .await
            .map_err(|_| ApiError::network())?;
        let status = response.status().as_u16();
        if response.status().is_success() || status == 401 {
            Ok(())
        } else {
            Err(ApiError { status, code: "LOGOUT_FAILED".into() })
        }
    }
}

#[cfg(test)]
mod tests {
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
}
