import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { InputOtp } from "@openedbot/browser-ui-kit/components/ui/input-otp";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@openedbot/browser-ui-kit/components/ui/tooltip";
import { isEmailSyntaxValid, normalizeEmail } from "@openedbot/identity/domain/email-address";
import { hasMessage } from "@openedbot/browser-i18n";
import { api, isAlphaClosed, queryKeys } from "../../lib/api";
import { nativeAuth } from "../../lib/platform";
import { useT, type MessageKey } from "../../lib/i18n";
import { GoogleMark, useGoogleSignIn } from "./login-google";
import { MatrixSpinner, SigninBrand, SigninFooter, SigninNote, SigninReassurance } from "./login-parts";
import { dropLoginBoot, flyLoginBoot, hasLoginBoot } from "./login-boot";
import { loginFailureCode, loginTransport } from "./login-transport";

export { clearPendingAttempt, PENDING_ATTEMPT_KEY } from "./login-google";

/**
 * `/login`: the application's door, the same in the browser and in the
 * desktop app (the shell shows it and carries the sign-in through its bridge,
 * `login-transport.ts`).
 *
 * A single form to sign in or create an account: the address, then a
 * one-time code received by e-mail (6 digits, 10 minutes, five tries;
 * `modules/identity/src/application/email-login-code.ts`). Google stays
 * offered in one click under the form. There is no longer a password on
 * screen (the API keeps it, cut off in production).
 *
 * Each refusal is named with its gesture. Once the session is established, the guard
 * brings the window back to where it came from (`?redirect=`), not this screen.
 */

/** COOLDOWN_MS de `email-login-code.ts`, en secondes. */
const RESEND_COOLDOWN_SECONDS = 60;
const CODE_LENGTH = 6;
/** A refused code stays on screen while the row shakes (200 ms), then clears for the next try. */
const REFUSED_CODE_CLEAR_MS = 450;

type CodeStep = { email: string; sentAt: number; resent: boolean };

function emailFromQuery(raw: string | undefined): string {
  if (!raw) return "";
  const address = normalizeEmail(raw);
  return isEmailSyntaxValid(address) ? address : "";
}

export function LoginScreen({ reason, email: emailQuery }: { reason?: string; email?: string }) {
  const { locale, t } = useT();
  const native = useMemo(() => nativeAuth(), []);
  const transport = useMemo(() => loginTransport(native), [native]);
  const [failure, setFailure] = useState<string | null>(null);
  const reportFailure = useCallback((code: string | null) => setFailure(code), []);
  const google = useGoogleSignIn(native, reportFailure);

  // Launched on `/login`: the boot mascot flies into the logo while the rest
  // of the card rises (`login-boot.ts`). Entered from the app: the card's
  // own entrance only.
  const cardRef = useRef<HTMLDivElement>(null);
  const [fromBoot] = useState(hasLoginBoot);
  const [landed, setLanded] = useState(!fromBoot);
  useLayoutEffect(() => {
    if (!fromBoot) return;
    const mark = cardRef.current?.querySelector<HTMLElement>(".si-brand-mark");
    // Synchronous: the logo's own mark must be painted before the mascot
    // goes, or a frame shows neither (a flash on landing).
    const stop = mark ? flyLoginBoot(mark, () => flushSync(() => setLanded(true))) : null;
    if (!stop) {
      if (!mark) dropLoginBoot();
      setLanded(true);
      return;
    }
    return stop;
  }, [fromBoot]);

  const providers = useQuery({ queryKey: queryKeys.authProviders, queryFn: api.authProviders });
  // A legal page is linked only if the deployment SERVES it: an unreachable
  // or empty catalogue links nothing (same rule as the transactional e-mails).
  const legal = useQuery({ queryKey: queryKeys.legalCatalog, queryFn: api.legalCatalog, retry: false });
  const publishedLegal = (legal.data?.documents ?? []).filter((entry) => entry.available).map((entry) => entry.slug);
  const alphaClosed = isAlphaClosed(providers.error);
  const googleProvider = providers.data?.google;
  const emailCodeEnabled = providers.data?.emailCode?.enabled === true;

  const seededEmail = emailFromQuery(emailQuery);
  const [email, setEmail] = useState(seededEmail);
  useEffect(() => {
    const next = emailFromQuery(emailQuery);
    if (next) setEmail(next);
  }, [emailQuery]);
  const [codeStep, setCodeStep] = useState<CodeStep | null>(null);
  const [code, setCode] = useState("");
  // Accepted: the boxes turn green until the page leaves (`CODE_ACCEPTED_HOLD_MS`).
  const [accepted, setAccepted] = useState(false);
  // Refused: the boxes stay red until the next digit; `refusals` restarts the clearing.
  const [refused, setRefused] = useState(false);
  const [refusals, setRefusals] = useState(0);
  useEffect(() => {
    if (!refused) return;
    const timer = setTimeout(() => setCode(""), REFUSED_CODE_CLEAR_MS);
    return () => clearTimeout(timer);
  }, [refused, refusals]);

  /**
   * « Renvoyer » waits for the API's minute: during that minute, the API
   * answers 200 without sending anything while the first code is valid, and an
   * active button would look like it worked without any mail leaving.
   */
  const [now, setNow] = useState(() => Date.now());
  const resendIn = codeStep ? Math.max(0, RESEND_COOLDOWN_SECONDS - Math.floor((now - codeStep.sentAt) / 1_000)) : 0;
  useEffect(() => {
    if (resendIn === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [resendIn]);

  const requestCode = useMutation({
    mutationFn: (address: string) => transport.requestCode(address, locale),
    onMutate: () => setFailure(null),
    onSuccess: (_, address) => {
      const sentAt = Date.now();
      setCodeStep((previous) => ({ email: address, sentAt, resent: previous?.email === address }));
      setCode("");
      setNow(sentAt);
    },
    onError: (error) => setFailure(loginFailureCode(error, "EMAIL_LOGIN_CODE_UNSENT")),
  });
  const verifyCode = useMutation({
    mutationFn: (input: { email: string; code: string }) => transport.verifyCode(input.email, input.code, () => setAccepted(true)),
    onMutate: () => {
      setFailure(null);
      setRefused(false);
    },
    // Web: `authEmailLogin` has set the session, the root `CloudSessionGate`
    // does the only navigation. Shell: it replaces the page. The code stays
    // on screen, green, until then.
    onError: (error) => {
      setAccepted(false);
      setRefused(true);
      setRefusals((count) => count + 1);
      setFailure(loginFailureCode(error, "UNKNOWN"));
    },
  });
  const busy = requestCode.isPending || verifyCode.isPending || accepted || google.starting || google.waiting;
  const otpStatus = accepted ? "success" : verifyCode.isPending ? "verifying" : refused ? "error" : "idle";

  const submitCode = (value: string) => {
    if (!codeStep || busy || value.length !== CODE_LENGTH) return;
    verifyCode.mutate({ email: codeStep.email, code: value });
  };
  const backToEmail = () => {
    setCodeStep(null);
    setCode("");
    setFailure(null);
    setRefused(false);
  };

  // The code comes from the API or the shell: a key missing from the dictionary
  // would display `login.failed.XXX`; we fall back to the generic message.
  const failureKey = failure ? `login.failed.${failure}` : null;
  const failureMessage = failureKey ? t(hasMessage(failureKey) ? (failureKey as MessageKey) : "login.failed.UNKNOWN") : null;
  const normalized = normalizeEmail(email);
  const emailValid = isEmailSyntaxValid(normalized);

  return (
    <div className="si">
      <main className="si-main">
        <div ref={cardRef} className={fromBoot ? "si-card si-card--from-boot" : "si-card"} data-landed={landed}>
          <SigninBrand linked={native === null} />

          {codeStep ? (
            <>
              {/* The key replays the copy's entrance when the code is accepted. */}
              <div key={accepted ? "accepted" : "code"} className="si-copy" data-swap={accepted || undefined}>
                <h1 className="si-title">{t(accepted ? "login.signedInTitle" : "login.codeTitle")}</h1>
                <p className="si-lead" role="status">
                  {accepted ? t("login.signedInLead") : (
                    <>
                      {t(codeStep.resent ? "login.emailCodeResent" : "login.emailCodeSent", { email: codeStep.email })}
                      <br />
                      {t("login.emailCodeExpiry")}
                    </>
                  )}
                </p>
              </div>
              <form className="si-form" noValidate onSubmit={(event) => {
                event.preventDefault();
                submitCode(code);
              }}>
                <InputOtp
                  className="si-otp"
                  length={CODE_LENGTH}
                  value={code}
                  status={otpStatus}
                  // A refused code is told on the boxes' own line, which keeps its
                  // height: a note under the links would move the centred card
                  // when it appears and again when the next try clears it.
                  message={accepted ? t("login.emailCodeVerified") : refused ? failureMessage : null}
                  onChange={(value) => {
                    setCode(value);
                    if (refused) {
                      setRefused(false);
                      setFailure(null);
                    }
                    // Six digits typed or pasted: we verify without waiting for the button.
                    if (value.length === CODE_LENGTH) submitCode(value);
                  }}
                  disabled={requestCode.isPending}
                  autoFocus
                  aria-label={t("login.emailCodeLabel")}
                />
                <button type="submit" className="si-primary" data-hidden={accepted || undefined} disabled={busy || code.length !== CODE_LENGTH} aria-busy={verifyCode.isPending}>
                  {verifyCode.isPending ? (
                    <>
                      <MatrixSpinner />
                      {t("login.verifying")}
                    </>
                  ) : t("login.emailCodeVerify")}
                </button>
              </form>
              <div className="si-links" data-hidden={accepted || undefined}>
                <button type="button" className="si-link" disabled={busy || resendIn > 0} onClick={() => requestCode.mutate(codeStep.email)}>
                  {resendIn > 0 ? t("login.emailCodeResendIn", { seconds: resendIn }) : t("login.emailCodeResend")}
                </button>
                <button type="button" className="si-link" disabled={verifyCode.isPending} onClick={backToEmail}>
                  {t("login.changeEmail")}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="si-copy">
                <h1 className="si-title">{t("login.title")}</h1>
                <p className="si-lead">{t("login.intro")}</p>
              </div>

              {reason === "SESSION_EXPIRED" ? <SigninNote tone="warning">{t("login.sessionExpired")}</SigninNote> : null}
              {reason === "SESSION_REVOKED" ? <SigninNote tone="warning">{t("login.sessionRevoked")}</SigninNote> : null}

              {providers.isPending ? <p className="si-lead" role="status">{t("common.loading")}</p> : null}
              {alphaClosed ? (
                <SigninNote tone="neutral" role="status">
                  <h2>{t("login.alphaClosed.title")}</h2>
                  <p>{t("login.alphaClosed.body")}</p>
                  <a className="si-link" href="/">{t("login.alphaClosed.action")}</a>
                </SigninNote>
              ) : providers.error && !providers.isPending ? (
                <div className="si-form">
                  <SigninNote tone="warning" role="alert">
                    <h2>{t("login.unavailableTitle")}</h2>
                    <p>{t("login.unreachable")}</p>
                  </SigninNote>
                  <button type="button" className="si-secondary" disabled={providers.isFetching} onClick={() => void providers.refetch()}>
                    {t(providers.isFetching ? "common.loading" : "common.retry")}
                  </button>
                </div>
              ) : null}

              {google.waiting ? (
                <div className="si-form">
                  <div className="si-pending" role="status">
                    <MatrixSpinner />
                    <span>{t("login.googleWaiting")}</span>
                  </div>
                  <button type="button" className="si-secondary" onClick={google.cancel}>{t("login.googleCancel")}</button>
                </div>
              ) : providers.data ? (
                <>
                  {emailCodeEnabled ? (
                    <form className="si-form" noValidate onSubmit={(event) => {
                      event.preventDefault();
                      if (busy || !emailValid) return;
                      setEmail(normalized);
                      requestCode.mutate(normalized);
                    }}>
                      <label className="si-sr-only" htmlFor="si-email">{t("login.passwordEmail")}</label>
                      <input
                        id="si-email"
                        className="si-input"
                        type="email"
                        name="email"
                        autoComplete="email"
                        inputMode="email"
                        placeholder={t("login.emailPlaceholder")}
                        required
                        value={email}
                        disabled={busy}
                        autoFocus={seededEmail === ""}
                        onChange={(event) => setEmail(event.target.value)}
                      />
                      <button type="submit" className="si-primary" disabled={busy || !emailValid}>
                        {requestCode.isPending ? t("login.sendingCode") : t("login.sendCode")}
                      </button>
                    </form>
                  ) : null}
                  {googleProvider ? (
                    <>
                      {emailCodeEnabled ? <p className="si-divider">{t("login.or")}</p> : null}
                      {googleProvider.enabled ? (
                        <button type="button" className="si-google" disabled={busy} onClick={google.start}>
                          <GoogleMark />
                          {google.starting ? t("login.googleStarting") : t("login.google")}
                        </button>
                      ) : (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button type="button" className="si-google" aria-disabled="true">
                                <GoogleMark />
                                {t("login.google")}
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="top" sideOffset={8} collisionPadding={16}>
                              {t(googleProvider.reason === "origin_unsupported" ? "login.googleDisabledOriginUnsupported" : "login.googleDisabledNotConfigured")}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                    </>
                  ) : null}
                </>
              ) : null}
            </>
          )}

          {failureMessage && !refused ? <SigninNote tone="danger" role="alert">{failureMessage}</SigninNote> : null}
          <SigninReassurance />
        </div>
      </main>
      <SigninFooter legal={publishedLegal} />
    </div>
  );
}
