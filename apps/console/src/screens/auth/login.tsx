import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { IconEye, IconEyeOff, IconLock, IconMail, IconMoon, IconSun } from "@tabler/icons-react";
import type { AuthClaimDto, LegalSlug } from "@openedbot/contracts-api";
import { useTheme } from "@openedbot/browser-ui-kit/theme";
import { InputOtp } from "@openedbot/browser-ui-kit/components/ui/input-otp";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@openedbot/browser-ui-kit/components/ui/tooltip";
import { isEmailSyntaxValid, normalizeEmail } from "@openedbot/identity/domain/email-address";
import { ApiError, api, isAlphaClosed, isApiUnavailable, queryKeys } from "../../lib/api";
import { leaveTo } from "../../lib/platform/open-external";
import { APP_HOME_HREF } from "../../lib/session/public-landing-gate";
import { publicSiteUrl } from "../../lib/session/public-site";
import { useT, type MessageKey } from "../../lib/i18n";
import { hasMessage } from "@openedbot/browser-i18n";
import { BUTTON } from "../../components/settings/primitives";

/**
 * `/login` : la porte de l'application (US-ONB-14).
 *
 * On y arrive par le garde de `route-tree.tsx` quand la session cloud est
 * absente ou expirée. Trois chemins d'authentification SaaS sont disponibles :
 * - **« Continuer avec Google »** : la fenêtre part vers Google dans le MÊME
 *   onglet (`leaveTo`) avec `returnTo = ici`, mémorise sa tentative en
 *   `sessionStorage`, et à son retour cette page la reprend : spinner,
 *   `authClaim`, jeton, redirection. Le jeton de session ne transite jamais
 *   par une URL.
 * - **Email code**: signup and sign-in share a single-use code. New accounts
 *   continue through the existing organization onboarding.
 * - **Email et mot de passe** : ouvert tant que l'API publie
 *   `password.enabled`. En production (`OHB_DEPLOY_ENV=prod`) ce n'est pas
 *   le cas : Google et le code email restent disponibles. Dev et preprod le gardent.
 *
 * Style lives in `login.css`: an editorial, technical gate with a brief entry
 * motion, a themed illustration in the right panel, and a Google button that
 * keeps the official white, outlined treatment.
 *
 * Chaque refus est nommé avec son geste. Une fois la session établie, le garde
 * ramène la fenêtre là d'où elle venait (`?redirect=`), pas cet écran.
 */
const LEGAL_LABELS: Record<LegalSlug, "legal.mentions" | "legal.privacy" | "legal.terms"> = {
  mentions: "legal.mentions",
  privacy: "legal.privacy",
  terms: "legal.terms",
};

/** La tentative en cours, mémorisée le temps de l'aller-retour vers Google (mode web, même onglet). */
export const PENDING_ATTEMPT_KEY = "ohb:auth-attempt";

function readPendingAttempt(): string | null {
  try {
    return globalThis.window?.sessionStorage.getItem(PENDING_ATTEMPT_KEY) ?? null;
  } catch {
    return null;
  }
}
function writePendingAttempt(id: string | null) {
  try {
    if (id === null) globalThis.window?.sessionStorage.removeItem(PENDING_ATTEMPT_KEY);
    else globalThis.window?.sessionStorage.setItem(PENDING_ATTEMPT_KEY, id);
  } catch {
    // Sans sessionStorage, la reprise au retour n'aura pas lieu ; le sondage in situ reste possible.
  }
}

export function clearPendingAttempt(): void {
  writePendingAttempt(null);
}

type Attempt = { id: string };

// Transport failures must never look like rejected credentials or leak proxy errors.
function loginFailureCode(error: unknown, fallback: string): string {
  if (isApiUnavailable(error) || (error instanceof ApiError && error.status >= 500)) {
    return "SERVICE_UNAVAILABLE";
  }
  return error instanceof ApiError && error.code ? error.code : fallback;
}

/** COOLDOWN_MS of modules/identity/src/application/email-login-code.ts, in seconds. */
const RESEND_COOLDOWN_SECONDS = 60;

function emailFromQuery(raw: string | undefined): string {
  if (!raw) return "";
  const address = normalizeEmail(raw);
  return isEmailSyntaxValid(address) ? address : "";
}

export function LoginScreen({ reason, email: emailQuery }: { reason?: string; email?: string }) {
  const { locale, setLocale, t } = useT();
  const theme = useTheme();
  // Au montage : une tentative laissée par l'aller vers Google ? On la reprend
  // : c'est le retour du même onglet, le spinner tient jusqu'au jeton.
  const [attempt, setAttempt] = useState<Attempt | null>(() => {
    const pending = readPendingAttempt();
    return pending ? { id: pending } : null;
  });
  const [failure, setFailure] = useState<string | null>(null);

  const providers = useQuery({ queryKey: queryKeys.authProviders, queryFn: api.authProviders });
  /**
   * Les pages légales ne sont liées que si le déploiement en SERT vraiment.
   * En production, aucune n'a de contenu (`LEGAL_DOCUMENT_UNAVAILABLE`) : lier
   * une page vide depuis la porte du produit vaut moins que ne rien lier, et
   * c'est la même règle que les e-mails transactionnels appliquent déjà.
   *
   * Le catalogue le dit lui-même, document par document : pas de drapeau
   * d'environnement à tenir en phase, l'écran suit ce que l'API publie. Un
   * catalogue injoignable ne montre rien non plus : l'absence est le repli.
   */
  const legal = useQuery({ queryKey: queryKeys.legalCatalog, queryFn: api.legalCatalog, retry: false });
  const publishedLegal = (legal.data?.documents ?? [])
    .filter((entry) => entry.available)
    .map((entry) => entry.slug);
  const alphaClosed = isAlphaClosed(providers.error);
  const google = providers.data?.google;
  const password = providers.data?.password;
  const emailCodeEnabled = providers.data?.emailCode?.enabled;
  const seededEmail = emailFromQuery(emailQuery);
  const [email, setEmail] = useState(seededEmail);
  const [secret, setSecret] = useState("");
  // L'œil ne survit pas à la soumission : un mot de passe redevenu invisible
  // après coup est un mot de passe qui ne traîne pas à l'écran.
  const [secretShown, setSecretShown] = useState(false);

  /**
   * La connexion par mot de passe aboutit au MÊME endroit que Google : une
   * session cloud, puis le garde de route
   * réveillé. Rien en aval ne sait par quelle porte on est entré, et c'est
   * voulu : sinon chaque écran aurait à connaître les deux.
   */
  const signIn = useMutation({
    // Les identifiants sont un argument, pas une lecture d'état : le raccourci
    // de développement soumet le compte semé sans attendre le rendu suivant.
    mutationFn: (credentials: { email: string; password: string; emailCode?: string }) =>
      api.authPasswordLogin(credentials.email.trim(), credentials.password, credentials.emailCode),
    onMutate: () => setFailure(null),
    onSuccess: (result) => {
      if (result.status === "code_required") {
        setSecretShown(false);
        setCodeMode("password");
        setCodeEmail(email);
        setEmailCode("");
        setCodeResent(false);
        setStep("code");
        const sentAt = Date.now();
        setCodeSentAt(sentAt);
        setNow(sentAt);
        return;
      }
      setSecret("");
      setSecretShown(false);
      // `authPasswordLogin` persists the session synchronously. The root
      // `CloudSessionGate` observes that change and performs the single router
      // navigation, so this mutation must not trigger a second full reload.
    },
    onError: (error) =>
      setFailure(loginFailureCode(error, "UNKNOWN")),
  });

  /** The address first, then its method: password, or a code by email. */
  const [step, setStep] = useState<"email" | "password" | "code">("email");
  const [codeMode, setCodeMode] = useState<"email" | "password">("email");
  const [codeEmail, setCodeEmail] = useState<string | null>(null);
  const [emailCode, setEmailCode] = useState("");
  /**
   * « Renvoyer » attend la minute de l'API (COOLDOWN_MS,
   * modules/identity/src/application/email-login-code.ts). Pendant cette
   * minute, l'API répond 200 sans rien envoyer tant que le premier code est
   * valide : un bouton actif aurait l'air de marcher sans qu'aucun mail ne parte.
   */
  const [codeSentAt, setCodeSentAt] = useState<number | null>(null);
  const [codeResent, setCodeResent] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const resendIn = codeSentAt === null
    ? 0
    : Math.max(0, RESEND_COOLDOWN_SECONDS - Math.floor((now - codeSentAt) / 1_000));
  const resendWaiting = resendIn > 0;
  useEffect(() => {
    if (!resendWaiting) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [resendWaiting]);
  const requestCode = useMutation({
    mutationFn: (address: string) => api.authEmailCode(address, locale),
    onMutate: () => setFailure(null),
    onSuccess: (_, address) => {
      const passwordChallenge = codeMode === "password" && codeEmail === address;
      setCodeResent(codeEmail === address);
      setEmail(address);
      setCodeEmail(address);
      setEmailCode("");
      setCodeMode(passwordChallenge ? "password" : "email");
      setStep("code");
      const sentAt = Date.now();
      setCodeSentAt(sentAt);
      setNow(sentAt);
    },
    onError: (error) => setFailure(loginFailureCode(error, "EMAIL_LOGIN_CODE_UNSENT")),
  });
  const verifyCode = useMutation({
    mutationFn: () => api.authEmailLogin(codeEmail!, emailCode),
    onMutate: () => setFailure(null),
    onSuccess: () => { setEmailCode(""); setCodeEmail(null); },
    onError: (error) => setFailure(loginFailureCode(error, "UNKNOWN")),
  });
  const emailBusy = requestCode.isPending || verifyCode.isPending || signIn.isPending;
  const backToEmail = () => {
    setStep("email");
    setSecret("");
    setSecretShown(false);
    setEmailCode("");
    setCodeMode("email");
    setCodeEmail(null);
    setCodeSentAt(null);
    setCodeResent(false);
    setFailure(null);
  };

  const start = useMutation({
    mutationFn: async (): Promise<Attempt | null> => {
      // Même onglet. La tentative est posée AVANT de partir ; le cloud API
      // nous ramène ici (`returnTo`) une fois Google passé.
      const started = await api.authStart(globalThis.window?.location.href);
      writePendingAttempt(started.attemptId);
      leaveTo(started.authorizeUrl);
      // La fenêtre part : on garde le spinner jusqu'à ce qu'elle soit remplacée.
      return { id: started.attemptId };
    },
    onMutate: () => setFailure(null),
    onSuccess: (started) => setAttempt(started),
    onError: (error) => setFailure(loginFailureCode(error, "AUTH_EXCHANGE_FAILED")),
  });

  useEffect(() => {
    const next = emailFromQuery(emailQuery);
    if (!next) return;
    setEmail(next);
    setSecret("");
  }, [emailQuery]);

  // Le sondage : actif tant qu'une tentative est ouverte et qu'elle est `pending`.
  const claim = useQuery<AuthClaimDto>({
    queryKey: queryKeys.authClaim(attempt?.id ?? ""),
    queryFn: () => api.authClaim(attempt!.id),
    enabled: attempt !== null,
    retry: false,
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 1_500 : false),
  });

  useEffect(() => {
    if (!attempt) return;
    const outcome: AuthClaimDto | undefined = claim.data;
    if (outcome?.status === "done") {
      clearPendingAttempt();
      setAttempt(null);
      const window = globalThis.window;
      // Same as the password path: the slug directory survives the reload, so `/home` becomes `/o/<slug>/`.
      if (window) void api.primeWorkspaceDirectory().then(() => window.location.assign(new URL(APP_HOME_HREF, window.location.href).href));
    } else if (outcome?.status === "failed") {
      clearPendingAttempt();
      setFailure(outcome.code);
      setAttempt(null);
    } else if (claim.error) {
      clearPendingAttempt();
      setFailure(loginFailureCode(claim.error, "AUTH_EXCHANGE_FAILED"));
      setAttempt(null);
    }
  }, [attempt, claim.data, claim.error]);

  const cancel = () => {
    clearPendingAttempt();
    setAttempt(null);
  };

  // Le code vient de l'API : une clé fabriquée qui manque au dictionnaire
  // afficherait `login.failed.XXX` à l'écran. On retombe sur un message
  // générique plutôt que de laisser fuir la clé.
  const failureKey = failure ? `login.failed.${failure}` : null;
  const failureMessage = failureKey
    ? t(hasMessage(failureKey) ? (failureKey as MessageKey) : "login.failed.UNKNOWN")
    : null;

  return (
    <div className="lg">
      <div className="lg-shell">
        <section className="lg-main">
          <LoginBrand />
          <div className="lg-content">
            <div className="lg-copy">
              <h1 className="lg-title">{t("login.title")}</h1>
              <p className="lg-lead">{t("login.intro")}</p>
            </div>

          {reason === "SESSION_EXPIRED" ? <LoginNote tone="warning">{t("login.sessionExpired")}</LoginNote> : null}
          {reason === "SESSION_REVOKED" ? <LoginNote tone="warning">{t("login.sessionRevoked")}</LoginNote> : null}

          <div className="lg-actions">
            {providers.isPending ? <p className="lg-lead">{t("common.loading")}</p> : null}
            {alphaClosed ? (
              <div className="lg-note" data-tone="neutral" role="status">
                <h2>{t("login.alphaClosed.title")}</h2>
                <p>{t("login.alphaClosed.body")}</p>
                <a className="lg-link" href="/">{t("login.alphaClosed.action")}</a>
              </div>
            ) : providers.error && !providers.isPending ? (
              <div className="lg-recovery">
                <LoginNote tone="warning" role="alert">
                  <h2>{t("login.unavailableTitle")}</h2>
                  <p>{t("login.unreachable")}</p>
                </LoginNote>
                <button
                  type="button"
                  className={BUTTON.soft}
                  disabled={providers.isFetching}
                  onClick={() => { void providers.refetch(); }}
                >
                  {t(providers.isFetching ? "common.loading" : "common.retry")}
                </button>
              </div>
            ) : null}
            {google && !google.enabled && !attempt ? (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" className="lg-google" aria-disabled="true">
                      <GoogleMark />
                      {t("login.google")}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={8} collisionPadding={16}>
                    {t(
                      google.reason === "origin_unsupported"
                        ? "login.googleDisabledOriginUnsupported"
                        : "login.googleDisabledNotConfigured",
                    )}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
            {google?.enabled && !attempt ? (
              <button type="button" className="lg-google" disabled={start.isPending || emailBusy} onClick={() => start.mutate()}>
                <GoogleMark />
                {start.isPending ? t("login.googleStarting") : t("login.google")}
              </button>
            ) : null}
            {attempt ? (
              <div className="lg-waiting">
                <div className="lg-pending" role="status">
                  <MatrixSpinner />
                  <span>{t("login.googleWaiting")}</span>
                </div>
                <button type="button" className="lg-ghost" onClick={cancel}>
                  {t("login.googleCancel")}
                </button>
              </div>
            ) : null}
            {(emailCodeEnabled || password?.enabled) && !attempt && step === "email" ? (
              <form className="lg-password" noValidate onSubmit={(event) => {
                event.preventDefault();
                if (emailBusy || start.isPending) return;
                const field = event.currentTarget.elements.namedItem("email") as HTMLInputElement;
                if (!field.reportValidity()) return;
                const address = normalizeEmail(email);
                setEmail(address);
                setFailure(null);
                // Same flow as OpenTrack: the address first, no API call (an
                // unknown address learns nothing), then the method step.
                if (password?.enabled) setStep("password");
                else requestCode.mutate(address);
              }}>
                {google ? <p className="lg-divider">{t("login.emailCodeTitle")}</p> : null}
                <label className="lg-field">
                  <span>{t("login.passwordEmail")}</span>
                  <span className="lg-field-control">
                    <IconMail aria-hidden="true" />
                    <input type="email" name="email" autoComplete="username" inputMode="email" required value={email}
                      disabled={emailBusy} autoFocus={seededEmail === ""}
                      onChange={(event) => setEmail(event.target.value)} />
                  </span>
                </label>
                <button type="submit" className={BUTTON.primary} disabled={emailBusy || start.isPending || !email.trim()}>
                  {emailBusy ? t("common.loading") : t("login.continue")}
                </button>
              </form>
            ) : null}
            {!attempt && step !== "email" ? (
              <div className="lg-identity">
                <span className="lg-identity-email">{t("login.signingInAs", { email })}</span>
                <button type="button" className="lg-identity-change" disabled={emailBusy || signIn.isPending} onClick={backToEmail}>
                  {t("login.changeEmail")}
                </button>
              </div>
            ) : null}
            {password?.enabled && !attempt && step === "password" ? (
              <form className="lg-password" noValidate onSubmit={(event) => {
                event.preventDefault();
                if (signIn.isPending || emailBusy) return;
                const field = event.currentTarget.elements.namedItem("password") as HTMLInputElement;
                if (!field.reportValidity()) return;
                signIn.mutate({ email, password: secret });
              }}>
                {/* The address stays in the form for password managers. */}
                <input type="email" name="email" autoComplete="username" value={email} readOnly hidden />
                {/*
                  Un <div> et pas un <label> enveloppant, exprès : l'œil est un
                  bouton DANS le champ, et un bouton sous un label devient une
                  seconde cible de l'étiquette (deux contrôles pour un nom, et
                  le clic du label qui ricoche). `htmlFor` garde l'association.
                */}
                <div className="lg-field">
                  <label htmlFor="lg-password-input">{t("login.passwordPassword")}</label>
                  <span className="lg-field-control lg-field-control--secret">
                    <IconLock aria-hidden="true" />
                    <input
                      id="lg-password-input"
                      type={secretShown ? "text" : "password"}
                      name="password"
                      autoComplete="current-password"
                      autoFocus
                      required
                      value={secret}
                      onChange={(event) => setSecret(event.target.value)}
                    />
                    <button
                      type="button"
                      className="lg-eye"
                      aria-pressed={secretShown}
                      aria-label={t(secretShown ? "login.passwordHide" : "login.passwordShow")}
                      onClick={() => setSecretShown((shown) => !shown)}
                    >
                      {secretShown ? <IconEyeOff aria-hidden="true" /> : <IconEye aria-hidden="true" />}
                    </button>
                  </span>
                </div>
                <button type="submit" className={BUTTON.primary} disabled={signIn.isPending || emailBusy || !secret}>
                  {signIn.isPending ? t("login.passwordSubmitting") : t("login.passwordSubmit")}
                </button>
                {emailCodeEnabled ? (
                  <button type="button" className={BUTTON.soft} disabled={signIn.isPending || emailBusy} onClick={() => {
                    // A code sent less than a minute ago is still the valid one.
                    if (codeEmail === email && resendWaiting) setStep("code");
                    else requestCode.mutate(email);
                  }}>
                    {requestCode.isPending ? t("common.loading") : t("login.emailCodeInstead")}
                  </button>
                ) : null}
              </form>
            ) : null}
            {emailCodeEnabled && !attempt && step === "code" && codeEmail ? (
              <form className="lg-password" noValidate onSubmit={(event) => {
                event.preventDefault();
                if (emailBusy || emailCode.length !== 6) return;
                if (codeMode === "password") {
                  signIn.mutate({ email: codeEmail!, password: secret, emailCode });
                } else {
                  verifyCode.mutate();
                }
              }}>
                <p className="lg-lead" role="status">{t(codeResent ? "login.emailCodeResent" : "login.emailCodeSent", { email: codeEmail })}</p>
                <div className="lg-field" role="group" aria-label={t("login.emailCodeLabel")}>
                  <span>{t("login.emailCodeLabel")}</span>
                  <InputOtp
                    length={6}
                    value={emailCode}
                    onChange={setEmailCode}
                    disabled={emailBusy}
                    autoFocus
                    aria-label={t("login.emailCodeLabel")}
                    inputClassName="lg-otp-box"
                  />
                </div>
                <button type="submit" className={BUTTON.primary} disabled={emailBusy || emailCode.length !== 6}>
                  {emailBusy ? t("common.loading") : t("login.emailCodeVerify")}
                </button>
                <button type="button" className={BUTTON.soft} disabled={emailBusy || resendWaiting} onClick={() => requestCode.mutate(codeEmail)}>
                  {resendWaiting ? t("login.emailCodeResendIn", { seconds: resendIn }) : t("login.emailCodeResend")}
                </button>
                {password?.enabled && codeMode === "email" ? (
                  <button type="button" className="lg-ghost" disabled={emailBusy} onClick={() => { setEmailCode(""); setFailure(null); setStep("password"); }}>
                    {t("login.passwordInstead")}
                  </button>
                ) : null}
              </form>
            ) : null}
            {providers.data?.waitlist?.required && !attempt ? (
              <a className="lg-link" href="/#ob-join">{t("login.waitlistLink")}</a>
            ) : null}
            {failureMessage ? (
              <LoginNote tone="danger" role="alert">
                {failureMessage}
              </LoginNote>
            ) : null}
          </div>
          </div>

          <div className="lg-footer">
            <div className="lg-legal">
              <p>{t("login.ledgerFootnote")}</p>
              {publishedLegal.length > 0 ? (
                <nav className="lg-legal-links" aria-label={t("legal.navigationLabel")}>
                  {publishedLegal.map((slug) => (
                    <Link key={slug} to="/legal/$slug" params={{ slug }}>{t(LEGAL_LABELS[slug])}</Link>
                  ))}
                </nav>
              ) : null}
            </div>
            <div className="lg-footer-controls">
              <fieldset className="lg-locale">
                <legend className="lg-sr-only">{t("settings.appearance.languageTitle")}</legend>
                {(["fr", "en"] as const).map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    aria-pressed={locale === candidate}
                    onClick={() => setLocale(candidate)}
                    className="lg-locale-option"
                  >
                    {candidate}
                  </button>
                ))}
              </fieldset>
              <button
                type="button"
                role="switch"
                aria-checked={theme.resolved === "dark"}
                aria-label={t(theme.resolved === "dark" ? "settings.appearance.themeLight" : "settings.appearance.themeDark")}
                onClick={() => theme.setMode(theme.resolved === "dark" ? "light" : "dark")}
                className="lg-theme-toggle"
              >
                {theme.resolved === "dark" ? <IconMoon aria-hidden="true" /> : <IconSun aria-hidden="true" />}
              </button>
            </div>
          </div>
        </section>
        <aside className="lg-panel" aria-hidden="true" />
      </div>
    </div>
  );
}

/** Le loader : une matrice 3×3 de points qui s'allument tour à tour, le temps du consentement. */
function MatrixSpinner() {
  return (
    <span className="lg-matrix" aria-hidden="true">
      {Array.from({ length: 9 }, (_, index) => (
        <span key={index} style={{ "--k": index } as React.CSSProperties} />
      ))}
    </span>
  );
}

/** Le « G » de Google : le logo officiel en SVG, tel que la charte le demande à gauche du libellé. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

function LoginNote({ tone, role, children }: { tone: "warning" | "danger" | "neutral"; role?: "alert" | "status"; children: ReactNode }) {
  return (
    <div className="lg-note" data-tone={tone} role={role}>
      {children}
    </div>
  );
}

/**
 * La marque ramène au site public quand la build en a un (`VITE_PUBLIC_SITE_URL`),
 * sinon à l'application (`/`, que la coque renvoie ici sans session).
 */
function LoginBrand() {
  const site = publicSiteUrl();
  const content = (
    <>
      <span className="lg-brand-mark">
        <img src="/brand/ohb-icon.webp" alt="" aria-hidden="true" />
      </span>
      <span>ohb</span>
    </>
  );
  if (site) return <a href={`${site}/`} className="lg-brand" aria-label="ohb">{content}</a>;
  return <Link to="/" className="lg-brand" aria-label="ohb">{content}</Link>;
}
