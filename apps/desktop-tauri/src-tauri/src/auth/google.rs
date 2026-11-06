//! Google sign-in, as in the Electron shell (`auth.ts`, `runSignIn`): the API
//! starts an attempt bound to a PKCE challenge, the system browser shows
//! Google (which refuses embedded web views), and the shell polls the claim
//! until the API says done, failed, or the attempt times out. The browser's
//! return (`openedbot://auth/callback`, or the loopback page on
//! `127.0.0.1:47813`) only means "poll now": the claim is what authenticates,
//! and the callback's query is never read.

use super::*;
use url::Url;

/// What the Google door needs from the shell: the loopback listener (when the
/// redirect is the loopback one) and the system browser. `attempt` lets the
/// listener tell a stale attempt from the one that owns it.
pub trait GoogleSteps: Send + Sync + 'static {
    fn start_loopback(&self, attempt: u64) -> Result<(), StepFailed>;
    fn stop_loopback(&self, attempt: u64);
    fn open_browser(&self, url: &Url) -> Result<(), StepFailed>;
}

/// A step of the shell refused (port taken, no browser); the step logs why.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("the shell could not take this step")]
pub struct StepFailed;

/// The only hosts an authorize URL may point at: Google, the API, the public console.
#[derive(Debug, Clone)]
pub struct AuthorizeTargets {
    pub api_origin: String,
    pub console_origin: String,
}

#[derive(Debug, Clone, Copy)]
pub struct GoogleTiming {
    pub poll: Duration,
    pub timeout: Duration,
}

impl Default for GoogleTiming {
    fn default() -> Self {
        Self { poll: Duration::from_millis(1_500), timeout: Duration::from_secs(5 * 60) }
    }
}

/// A 4xx will not heal by itself; network errors and 5xx get this many more tries.
const MAX_POLL_FAILURES: u32 = 5;

enum Outcome {
    Tokens(NativeTokens),
    Failed(SigninState),
    /// Cancelled or superseded: nothing to report.
    Dropped,
}

impl AuthorizeTargets {
    /// `https` on Google, the API or the console; plain `http` only on the
    /// configured API origin itself (a lab API).
    pub fn check(&self, raw: &str) -> Option<Url> {
        let url = Url::parse(raw).ok()?;
        let host = url.host_str()?.to_ascii_lowercase();
        let host_of = |origin: &str| Url::parse(origin).ok().and_then(|url| url.host_str().map(str::to_ascii_lowercase));
        let allowed = host == "accounts.google.com" || Some(&host) == host_of(&self.api_origin).as_ref() || Some(&host) == host_of(&self.console_origin).as_ref();
        let secure = url.scheme() == "https" || (url.scheme() == "http" && url.origin().ascii_serialization() == self.api_origin);
        (allowed && secure && url.username().is_empty() && url.password().is_none()).then_some(url)
    }
}

impl<A: AuthApi, V: Vault> AuthService<A, V> {
    /// Runs one Google attempt to its end. Progress and failures are reported
    /// as sign-in states; success signs in. A second call supersedes the first.
    pub async fn sign_in_with_google<G: GoogleSteps + ?Sized>(&self, steps: &G, targets: &AuthorizeTargets, client_id: &str, timing: GoogleTiming) {
        let attempt = self.begin_attempt();
        self.report(SigninState::Waiting);
        let outcome = self.google_flow(attempt, steps, targets, client_id, timing).await;
        steps.stop_loopback(attempt);
        if !self.attempt_current(attempt) {
            return;
        }
        match outcome {
            Outcome::Tokens(tokens) => self.complete_sign_in(attempt, tokens),
            Outcome::Failed(state) => {
                if let SigninState::Error { code, .. } = &state {
                    log::warn!("Google sign-in failed ({code})");
                }
                self.report(state);
            }
            Outcome::Dropped => {}
        }
    }

    /// Waits for the next poll, the browser's return, or a cancel.
    async fn pause(&self, poll: Duration) {
        tokio::select! {
            _ = tokio::time::sleep(poll) => {}
            _ = self.wake.notified() => {}
        }
    }

    async fn google_flow<G: GoogleSteps + ?Sized>(&self, attempt: u64, steps: &G, targets: &AuthorizeTargets, client_id: &str, timing: GoogleTiming) -> Outcome {
        let (verifier, challenge) = create_pkce();
        if steps.start_loopback(attempt).is_err() {
            return Outcome::Failed(named_failure("LOOPBACK_BUSY"));
        }
        let started = match self
            .api
            .post_json("/api/auth/native/google/start", json!({ "codeChallenge": challenge, "redirectUri": self.redirect_uri, "clientId": client_id }))
            .await
        {
            Ok(started) => started,
            Err(error) => return Outcome::Failed(failure(&error)),
        };
        if !self.attempt_current(attempt) {
            return Outcome::Dropped;
        }
        let (Some(attempt_id), Some(authorize)) = (started.get("attemptId").and_then(Value::as_str), started.get("authorizeUrl").and_then(Value::as_str)) else {
            return Outcome::Failed(named_failure("BAD_RESPONSE"));
        };
        let Some(authorize) = targets.check(authorize) else {
            return Outcome::Failed(named_failure("AUTHORIZE_URL_UNEXPECTED"));
        };
        if steps.open_browser(&authorize).is_err() {
            return Outcome::Failed(named_failure("BROWSER_UNAVAILABLE"));
        }
        log::info!("Google sign-in: browser opened, polling the claim");

        let deadline = tokio::time::Instant::now() + timing.timeout;
        let mut failures = 0u32;
        loop {
            if tokio::time::Instant::now() >= deadline {
                return Outcome::Failed(named_failure("TIMEOUT"));
            }
            self.pause(timing.poll).await;
            if !self.attempt_current(attempt) {
                return Outcome::Dropped;
            }
            let claim = self
                .api
                .post_json("/api/auth/native/google/claim", json!({ "attemptId": attempt_id, "codeVerifier": verifier, "redirectUri": self.redirect_uri }))
                .await;
            if !self.attempt_current(attempt) {
                return Outcome::Dropped;
            }
            let claim = match claim {
                Ok(claim) => {
                    failures = 0;
                    claim
                }
                Err(error) if (400..500).contains(&error.status) => return Outcome::Failed(failure(&error)),
                Err(error) => {
                    failures += 1;
                    if failures > MAX_POLL_FAILURES {
                        return Outcome::Failed(failure(&error));
                    }
                    continue;
                }
            };
            match claim.get("status").and_then(Value::as_str) {
                Some("done") => {
                    let Some(code) = claim.get("code").and_then(Value::as_str) else {
                        return Outcome::Failed(named_failure("BAD_RESPONSE"));
                    };
                    let exchanged = self
                        .api
                        .post_json(
                            "/api/auth/native/token",
                            json!({ "grantType": "authorization_code", "code": code, "codeVerifier": verifier, "redirectUri": self.redirect_uri }),
                        )
                        .await
                        .and_then(parse_tokens);
                    return match exchanged {
                        Ok(tokens) => Outcome::Tokens(tokens),
                        Err(error) => Outcome::Failed(failure(&error)),
                    };
                }
                Some("failed") => {
                    let code = claim.get("code").and_then(Value::as_str).filter(|code| known_message(code).is_some()).unwrap_or("GOOGLE_REFUSED");
                    return Outcome::Failed(named_failure(code));
                }
                // "pending" and any unknown status are not terminal: keep polling.
                _ => {}
            }
        }
    }
}
