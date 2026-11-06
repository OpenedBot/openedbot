//! The native session: e-mail code and Google sign-in (PKCE), single-flight
//! refresh, proactive refresh before expiry, sign-out. Port of the Electron
//! shell's `apps/desktop/src/main/auth.ts` (without the password door of its
//! local fallback page, which the embedded console does not have).
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
/// A proactive refresh that failed on the network or a 5xx is tried again
/// this long after: the refresh token is still valid.
const TRANSIENT_REFRESH_RETRY: Duration = Duration::from_secs(30);

mod google;
pub use google::{AuthorizeTargets, GoogleSteps, GoogleTiming, StepFailed};

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
    /// Rung on every session change, so the proactive refresh re-plans.
    changed: tokio::sync::Notify,
    /// Rung when the browser step of a Google attempt is over (deep link or
    /// loopback hit), or the attempt is cancelled: the claim is polled now.
    wake: tokio::sync::Notify,
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

const GENERIC_FAILURE: &str = "La connexion a échoué. Réessayez, et prévenez le support si cela se reproduit.";

/// The French fallback of a known failure code (the console translates the
/// code itself; same wording as the Electron shell's `FAILURE_MESSAGES`).
fn known_message(code: &str) -> Option<&'static str> {
    Some(match code {
        "EMAIL_LOGIN_CODE_INVALID" => "Code invalide ou expiré. Demandez un nouveau code.",
        "EMAIL_LOGIN_CODE_COOLDOWN" => "Patientez une minute avant de demander un nouveau code.",
        "EMAIL_LOGIN_CODE_UNSENT" => "Le code n’a pas pu être envoyé. Réessayez.",
        "RATE_LIMITED" => "Trop de tentatives : patientez une minute.",
        "REDIRECT_URI_INVALID" => "Cette version de l’application n’est pas autorisée par le serveur.",
        "AUTH_EMAIL_NOT_ALLOWED" => "Cette adresse n’est pas encore ouverte sur openedbot.",
        "MEMBERSHIP_REQUIRED" => "Ce compte est reconnu, mais il n’appartient à aucune organisation active : demandez une invitation à un administrateur.",
        "AUTH_NOT_A_MEMBER" => "Ce compte n’a pas encore d’organisation : créez-la depuis l’application web, puis reconnectez-vous.",
        "AUTH_DENIED" => "Connexion annulée dans Google.",
        "AUTH_EMAIL_NOT_VERIFIED" => "Google ne certifie pas cet e-mail : utilisez un compte dont l’adresse est vérifiée.",
        "AUTH_PROVIDER_DISABLED" => "Le SSO Google est désactivé sur cet environnement.",
        "GOOGLE_REFUSED" => "La connexion Google a été refusée ou a expiré. Réessayez.",
        "TIMEOUT" => "Délai dépassé : la connexion n’a pas abouti en 5 minutes.",
        "LOOPBACK_BUSY" => "Le port local 47813 est occupé : fermez l’application qui l’utilise puis réessayez.",
        "BROWSER_UNAVAILABLE" => "Le navigateur n’a pas pu être ouvert.",
        "AUTHORIZE_URL_UNEXPECTED" => "Le serveur a renvoyé une adresse de connexion inattendue.",
        "BAD_RESPONSE" => "Réponse inattendue du serveur de connexion.",
        _ => return None,
    })
}

/// User-facing failure of an API call: a code the console translates, and a French fallback.
fn failure(error: &ApiError) -> SigninState {
    // A transport failure or a 5xx is never a refusal of the credentials.
    if error.status == 0 || error.status >= 500 {
        let message = if error.status == 0 {
            "La connexion a échoué. Vérifiez votre réseau puis réessayez."
        } else {
            "Le service est indisponible. Réessayez dans un instant."
        };
        return SigninState::Error { code: "SERVICE_UNAVAILABLE".into(), message: message.into() };
    }
    SigninState::Error { code: error.code.clone(), message: known_message(&error.code).unwrap_or(GENERIC_FAILURE).into() }
}

/// A failure the shell names itself (timeout, busy port, refused claim).
fn named_failure(code: &str) -> SigninState {
    SigninState::Error { code: code.into(), message: known_message(code).unwrap_or(GENERIC_FAILURE).into() }
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
            changed: tokio::sync::Notify::new(),
            wake: tokio::sync::Notify::new(),
        }
    }

    /// The redirect URI this session binds its authorization codes to.
    pub fn redirect_uri(&self) -> &str {
        &self.redirect_uri
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
        let restored = {
            let mut inner = lock(&self.inner);
            inner.tokens = loaded;
            inner.tokens.is_some()
        };
        self.changed.notify_one();
        restored
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
        self.changed.notify_one();
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
        self.changed.notify_one();
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
            Ok(tokens) => self.complete_sign_in(attempt, tokens),
            Err(error) => {
                log::warn!("e-mail code sign-in failed ({error})");
                self.report(failure(&error));
            }
        }
    }

    /// Stores the tokens of a sign-in attempt, unless it was dropped.
    fn complete_sign_in(&self, attempt: u64, tokens: NativeTokens) {
        {
            // Checked under the lock that stores the tokens: a cancel or
            // sign-out landing after the caller's check must not be undone
            // by this late answer.
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

    /// Drops the attempt in progress and goes back to idle.
    pub fn cancel_sign_in(&self) {
        self.begin_attempt();
        // A Google attempt waiting between two polls notices at once.
        self.wake.notify_one();
        self.report(SigninState::Idle { reason: None });
    }

    /// The browser step is over (deep link or loopback hit): poll the claim now.
    pub fn nudge(&self) {
        self.wake.notify_one();
    }

    /// How long until the access token must be rotated; `None` signed out.
    fn next_refresh_in(&self) -> Option<Duration> {
        let inner = lock(&self.inner);
        let tokens = inner.tokens.as_ref()?;
        Some(remaining(tokens, OffsetDateTime::now_utc()).map_or(Duration::ZERO, |left| left.saturating_sub(REFRESH_MARGIN)))
    }

    /// Rotates the token shortly before it expires, for as long as the app
    /// runs: an idle console (or the popup alone) never meets a dead token,
    /// and a session lost while idle is noticed without a request. Runs
    /// forever; spawn it once.
    pub async fn keep_fresh(self: Arc<Self>) {
        let mut retry: Option<Duration> = None;
        loop {
            // Registered before the state is read: a change in between is not lost.
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let Some(delay) = retry.take().or_else(|| self.next_refresh_in()) else {
                changed.await;
                continue;
            };
            tokio::select! {
                _ = tokio::time::sleep(delay) => {
                    // `read_access_token` rotates only a token inside the margin.
                    // It also answers `Ok` with a still-alive token when the
                    // rotation failed: a token still due means "try later",
                    // never "try again now".
                    let read = self.read_access_token().await;
                    if let Err(error) = &read {
                        log::warn!("proactive refresh failed, retrying ({error})");
                    }
                    if read.is_err() || self.next_refresh_in() == Some(Duration::ZERO) {
                        retry = Some(TRANSIENT_REFRESH_RETRY);
                    }
                }
                _ = &mut changed => {}
            }
        }
    }

    /// Revokes the session on the API, then forgets it locally. The local
    /// part always happens: a failed revocation is logged and reported,
    /// never swallowed.
    pub async fn sign_out(&self) -> SignOutResult {
        self.begin_attempt();
        self.wake.notify_one();
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
mod tests;
