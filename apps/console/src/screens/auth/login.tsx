import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { InputOtp } from "@openedbot/browser-ui-kit/components/ui/input-otp";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@openedbot/browser-ui-kit/components/ui/tooltip";
import { isEmailSyntaxValid, normalizeEmail } from "@openedbot/identity/domain/email-address";
import { hasMessage } from "@openedbot/browser-i18n";
import { api, isAlphaClosed, queryKeys } from "../../lib/api";
import { nativeAuth } from "../../lib/platform/native-bridge";
import { useT, type MessageKey } from "../../lib/i18n";
import { GoogleMark, useGoogleSignIn } from "./login-google";
import { MatrixSpinner, SigninBrand, SigninFooter, SigninNote, SigninReassurance } from "./login-parts";
import { loginFailureCode, loginTransport } from "./login-transport";

export { clearPendingAttempt, PENDING_ATTEMPT_KEY } from "./login-google";

/**
 * `/login` : la porte de l'application, la même dans le navigateur et dans
 * l'app desktop (la coque l'affiche et mène la connexion par son pont,
 * `login-transport.ts`).
 *
 * Un seul formulaire pour se connecter ou créer un compte : l'adresse, puis un
 * code à usage unique reçu par e-mail (6 chiffres, 10 minutes, cinq essais ;
 * `modules/identity/src/application/email-login-code.ts`). Google reste
 * proposé en un clic sous le formulaire. Il n'y a plus de mot de passe à
 * l'écran (l'API le garde, coupé en production).
 *
 * Chaque refus est nommé avec son geste. Une fois la session établie, le garde
 * ramène la fenêtre là d'où elle venait (`?redirect=`), pas cet écran.
 */

/** COOLDOWN_MS de `email-login-code.ts`, en secondes. */
const RESEND_COOLDOWN_SECONDS = 60;
const CODE_LENGTH = 6;

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

  const providers = useQuery({ queryKey: queryKeys.authProviders, queryFn: api.authProviders });
  // Une page légale n'est liée que si le déploiement la SERT : un catalogue
  // injoignable ou vide ne lie rien (même règle que les e-mails transactionnels).
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

  /**
   * « Renvoyer » attend la minute de l'API : pendant cette minute, l'API
   * répond 200 sans rien envoyer tant que le premier code est valide, et un
   * bouton actif aurait l'air de marcher sans qu'aucun mail ne parte.
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
    mutationFn: (input: { email: string; code: string }) => transport.verifyCode(input.email, input.code),
    onMutate: () => setFailure(null),
    // Web : `authEmailLogin` a posé la session, le `CloudSessionGate` racine
    // fait la seule navigation. Coque : elle remplace la page.
    onSuccess: () => setCode(""),
    onError: (error) => {
      setCode("");
      setFailure(loginFailureCode(error, "UNKNOWN"));
    },
  });
  const busy = requestCode.isPending || verifyCode.isPending || google.starting || google.waiting;

  const submitCode = (value: string) => {
    if (!codeStep || busy || value.length !== CODE_LENGTH) return;
    verifyCode.mutate({ email: codeStep.email, code: value });
  };
  const backToEmail = () => {
    setCodeStep(null);
    setCode("");
    setFailure(null);
  };

  // Le code vient de l'API ou de la coque : une clé absente du dictionnaire
  // afficherait `login.failed.XXX` ; on retombe sur le message générique.
  const failureKey = failure ? `login.failed.${failure}` : null;
  const failureMessage = failureKey ? t(hasMessage(failureKey) ? (failureKey as MessageKey) : "login.failed.UNKNOWN") : null;
  const normalized = normalizeEmail(email);
  const emailValid = isEmailSyntaxValid(normalized);

  return (
    <div className="si">
      <main className="si-main">
        <div className="si-card">
          <SigninBrand linked={native === null} />

          {codeStep ? (
            <>
              <div className="si-copy">
                <h1 className="si-title">{t("login.codeTitle")}</h1>
                <p className="si-lead" role="status">
                  {t(codeStep.resent ? "login.emailCodeResent" : "login.emailCodeSent", { email: codeStep.email })}
                  <br />
                  {t("login.emailCodeExpiry")}
                </p>
              </div>
              <form className="si-form" noValidate onSubmit={(event) => {
                event.preventDefault();
                submitCode(code);
              }}>
                <div className="si-otp" role="group" aria-label={t("login.emailCodeLabel")}>
                  <InputOtp
                    length={CODE_LENGTH}
                    value={code}
                    onChange={(value) => {
                      setCode(value);
                      // Six chiffres saisis ou collés : on vérifie sans attendre le bouton.
                      if (value.length === CODE_LENGTH) submitCode(value);
                    }}
                    disabled={busy}
                    autoFocus
                    aria-label={t("login.emailCodeLabel")}
                    inputClassName="si-otp-box"
                  />
                </div>
                <button type="submit" className="si-primary" disabled={busy || code.length !== CODE_LENGTH}>
                  {verifyCode.isPending ? t("login.verifying") : t("login.emailCodeVerify")}
                </button>
              </form>
              <div className="si-links">
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
                  {providers.data.waitlist?.required ? <a className="si-link" href="/#ob-join">{t("login.waitlistLink")}</a> : null}
                </>
              ) : null}
            </>
          )}

          {failureMessage ? <SigninNote tone="danger" role="alert">{failureMessage}</SigninNote> : null}
          <SigninReassurance />
        </div>
      </main>
      <SigninFooter legal={publishedLegal} />
    </div>
  );
}
