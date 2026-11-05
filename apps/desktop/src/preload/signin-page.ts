import { ipcRenderer } from "electron";
import type { LegalSlug, SigninContext, SigninState } from "../shared/bridge";
import { CHANNEL } from "./channels";

// The local sign-in page (signin.html): since the shared /login of the
// console, only the fallback for a console that predates it (window.ts,
// localSigninFallback). Remove with signin.html one release after every
// deployed console serves the shared /login.

type Locale = "fr" | "en";
type Messages = Record<string, string>;

// The console's own wording (`login.*`, `legal.*` in ../../contracts/i18n),
// plus the shell's failures. The page is static: these strings are the only
// copy that changes with the language switch.
const MESSAGES: Record<Locale, Messages> = {
  fr: {
    title: "Bon retour.",
    intro: "Connectez-vous pour retrouver vos bots et vos conversations.",
    loading: "Chargement…",
    unreachable: "L’API cloud ne répond pas.",
    google: "Continuer avec Google",
    googleWaiting: "En attente de la connexion dans le navigateur : cette fenêtre se met à jour toute seule.",
    googleCancel: "Annuler",
    googleDisabledNotConfigured: "Le SSO Google n’est pas configuré sur cet environnement. Utilisez l’adresse e-mail et le mot de passe de votre compte cloud.",
    googleDisabledOriginUnsupported: "Le SSO Google n’aboutit pas depuis cet accès réseau local : connectez-vous avec l’adresse e-mail et le mot de passe.",
    passwordDivider: "ou",
    passwordEmail: "Adresse e-mail",
    passwordPassword: "Mot de passe",
    passwordShow: "Afficher le mot de passe",
    passwordHide: "Masquer le mot de passe",
    passwordSubmit: "Se connecter",
    passwordSubmitting: "Connexion…",
    passwordCodeSent: "Un code à 6 chiffres a été envoyé à cette adresse.",
    passwordCodeLabel: "Code à 6 chiffres",
    passwordCodeVerify: "Vérifier le code",
    passwordCodeResend: "Recevoir un nouveau code",
    devTitle: "Comptes de développement",
    devHint: "Choisis le compte propriétaire personnel ou le compte opérateur agence.",
    devRoleOwner: "Propriétaire de l’espace personnel",
    devRoleAgency: "Opérateur agence",
    devFill: "Remplir (dev)",
    devSubmitAs: "Se connecter comme {role}",
    envDev: "API dev",
    envPreprod: "API préprod",
    sessionLost: "Votre session a expiré : reconnectez-vous.",
    signedOut: "Vous êtes déconnecté.",
    ledgerFootnote: "Vos bots tournent sur votre machine.\nopenedbot garde vos conversations et vos réglages.",
    legalNav: "Documents légaux",
    "legal.mentions": "Mentions légales",
    "legal.privacy": "Politique de confidentialité",
    "legal.terms": "Conditions d’utilisation",
    language: "Langue",
    themeToLight: "Passer au thème clair",
    themeToDark: "Passer au thème sombre",
    "failed.CREDENTIALS_INVALID": "Adresse ou mot de passe incorrect.",
    "failed.AUTH_CREDENTIALS_INVALID": "Adresse ou mot de passe incorrect.",
    "failed.VALIDATION_ERROR": "L’adresse e-mail et le mot de passe sont requis.",
    "failed.MEMBERSHIP_REQUIRED": "Ce compte est reconnu, mais il n’appartient à aucune organisation active : demandez une invitation à un administrateur.",
    "failed.AUTH_NOT_A_MEMBER": "Ce compte n’a pas encore d’organisation : créez-la depuis l’application web, puis reconnectez-vous.",
    "failed.AUTH_DENIED": "Connexion annulée dans Google.",
    "failed.AUTH_EMAIL_NOT_VERIFIED": "Google ne certifie pas cet e-mail : utilisez un compte dont l’adresse est vérifiée.",
    "failed.AUTH_EMAIL_NOT_ALLOWED": "Cette adresse n’est pas encore ouverte sur openedbot : inscrivez-vous à la liste d’attente, nous vous écrirons dès que votre accès sera validé.",
    "failed.AUTH_PROVIDER_DISABLED": "Le SSO Google est désactivé sur cet environnement.",
    "failed.RATE_LIMITED": "Trop de tentatives : patientez une minute.",
    "failed.REDIRECT_URI_INVALID": "Cette version de l’application n’est pas autorisée par le serveur.",
    "failed.AUTH_PASSWORD_DISABLED": "La connexion par mot de passe n’est pas ouverte sur cet environnement.",
    "failed.EMAIL_LOGIN_CODE_INVALID": "Code invalide ou expiré. Demandez un nouveau code.",
    "failed.EMAIL_LOGIN_CODE_COOLDOWN": "Patientez une minute avant de demander un nouveau code.",
    "failed.EMAIL_LOGIN_CODE_UNSENT": "Le code n’a pas pu être envoyé. Réessayez.",
    "failed.LOOPBACK_BUSY": "Le port local 47813 est occupé : fermez l’application qui l’utilise puis réessayez.",
    "failed.BAD_RESPONSE": "Réponse inattendue du serveur de connexion.",
    "failed.AUTHORIZE_URL_UNEXPECTED": "Le serveur a renvoyé une adresse de connexion inattendue.",
    "failed.TIMEOUT": "Délai dépassé : la connexion n’a pas abouti en 5 minutes.",
    "failed.GOOGLE_REFUSED": "La connexion Google a été refusée ou a expiré. Réessayez.",
    "failed.NETWORK": "La connexion a échoué. Vérifiez votre réseau puis réessayez.",
    "failed.UNKNOWN": "La connexion a échoué. Réessayez, et prévenez le support si cela se reproduit.",
    "failed.CONSOLE_UNSUPPORTED": "La console {host} ne prend pas encore en charge l’application de bureau : elle ignore la session de l’app. Visez une console à jour (OPENEDBOT_CONSOLE_URL ou config.json).",
  },
  en: {
    title: "Welcome back.",
    intro: "Sign in to get back to your bots and your conversations.",
    loading: "Loading…",
    unreachable: "The cloud API is not answering.",
    google: "Continue with Google",
    googleWaiting: "Waiting for the sign-in in the browser: this window updates by itself.",
    googleCancel: "Cancel",
    googleDisabledNotConfigured: "Google SSO is not configured in this environment. Use your cloud account e-mail and password.",
    googleDisabledOriginUnsupported: "Google SSO cannot complete over this local-network address: sign in with your e-mail and password.",
    passwordDivider: "or",
    passwordEmail: "E-mail address",
    passwordPassword: "Password",
    passwordShow: "Show password",
    passwordHide: "Hide password",
    passwordSubmit: "Sign in",
    passwordSubmitting: "Signing in…",
    passwordCodeSent: "A 6-digit code was sent to this address.",
    passwordCodeLabel: "6-digit code",
    passwordCodeVerify: "Verify code",
    passwordCodeResend: "Send a new code",
    devTitle: "Development accounts",
    devHint: "Choose the seeded personal owner or agency operator account.",
    devRoleOwner: "Personal workspace owner",
    devRoleAgency: "Agency operator",
    devFill: "Fill (dev)",
    devSubmitAs: "Sign in as {role}",
    envDev: "Dev API",
    envPreprod: "Preprod API",
    sessionLost: "Your session has expired: sign in again.",
    signedOut: "You are signed out.",
    ledgerFootnote: "Your bots run on your machine.\nopenedbot keeps your conversations and your settings.",
    legalNav: "Legal documents",
    "legal.mentions": "Legal notice",
    "legal.privacy": "Privacy policy",
    "legal.terms": "Terms of service",
    language: "Language",
    themeToLight: "Switch to the light theme",
    themeToDark: "Switch to the dark theme",
    "failed.CREDENTIALS_INVALID": "Wrong e-mail or password.",
    "failed.AUTH_CREDENTIALS_INVALID": "Wrong e-mail or password.",
    "failed.VALIDATION_ERROR": "The e-mail address and the password are both required.",
    "failed.MEMBERSHIP_REQUIRED": "This account is recognised, but it belongs to no active organisation: ask an administrator for an invitation.",
    "failed.AUTH_NOT_A_MEMBER": "This account has no organisation yet: create it in the web app, then sign in again.",
    "failed.AUTH_DENIED": "Sign-in cancelled in Google.",
    "failed.AUTH_EMAIL_NOT_VERIFIED": "Google does not certify this e-mail: use an account with a verified address.",
    "failed.AUTH_EMAIL_NOT_ALLOWED": "This address is not open on openedbot yet: join the waitlist, we will write to you when your access is approved.",
    "failed.AUTH_PROVIDER_DISABLED": "Google SSO is disabled in this environment.",
    "failed.RATE_LIMITED": "Too many attempts: wait a minute.",
    "failed.REDIRECT_URI_INVALID": "This version of the app is not allowed by the server.",
    "failed.AUTH_PASSWORD_DISABLED": "Password sign-in is not open in this environment.",
    "failed.EMAIL_LOGIN_CODE_INVALID": "Invalid or expired code. Request a new code.",
    "failed.EMAIL_LOGIN_CODE_COOLDOWN": "Wait a minute before requesting another code.",
    "failed.EMAIL_LOGIN_CODE_UNSENT": "The code could not be sent. Please try again.",
    "failed.LOOPBACK_BUSY": "Local port 47813 is in use: close the app using it, then try again.",
    "failed.BAD_RESPONSE": "Unexpected answer from the sign-in server.",
    "failed.AUTHORIZE_URL_UNEXPECTED": "The server returned an unexpected sign-in address.",
    "failed.TIMEOUT": "Timed out: the sign-in did not complete within 5 minutes.",
    "failed.GOOGLE_REFUSED": "The Google sign-in was refused or expired. Try again.",
    "failed.NETWORK": "Sign-in failed. Check your network, then try again.",
    "failed.UNKNOWN": "Sign-in failed. Try again, and tell support if it happens again.",
    "failed.CONSOLE_UNSUPPORTED": "The console {host} does not support the desktop app yet: it ignores the app session. Point the app at an up-to-date console (OPENEDBOT_CONSOLE_URL or config.json).",
  },
};

const LOCALE_KEY = "openedbot:signin-locale";
const THEME_KEY = "openedbot:signin-theme";
// A template name becomes a file name: same rule as config.ts.
const TEMPLATE_PATTERN = /^[a-z0-9-]{1,40}$/;

function storedValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the choice holds for this window only.
  }
}

function fill(template: string, params: Record<string, string> = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match);
}

// The sign-in page is static HTML with a strict CSP (no script of its own), so
// the preload does the DOM wiring. Nothing is exposed to the page.
export function wireSigninPage(): void {
  const byId = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
  // Read lazily: at preload time the document does not exist yet.
  const root = (): HTMLElement => document.documentElement;

  let locale: Locale = storedValue(LOCALE_KEY) === "en" ? "en" : storedValue(LOCALE_KEY) === "fr" ? "fr" : navigator.language.toLowerCase().startsWith("fr") ? "fr" : "en";
  let state: SigninState = { status: "idle" };
  let passwordCodeRequired = false;
  let context: SigninContext | null = null;
  let contextSettled = false;
  const t = (key: string, params?: Record<string, string>): string => fill(MESSAGES[locale][key] ?? MESSAGES.fr[key] ?? key, params);

  const renderStatic = (): void => {
    root().lang = locale;
    for (const element of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
      const key = element.dataset.i18n;
      if (key) element.textContent = t(key);
    }
    for (const element of document.querySelectorAll<HTMLElement>("[data-i18n-label]")) {
      const key = element.dataset.i18nLabel;
      if (key) element.setAttribute("aria-label", t(key));
    }
    for (const option of document.querySelectorAll<HTMLButtonElement>(".locale-option")) {
      option.setAttribute("aria-pressed", String(option.dataset.locale === locale));
    }
    const dark = root().dataset.theme === "dark";
    const toggle = byId("theme-toggle");
    toggle?.setAttribute("aria-checked", String(dark));
    toggle?.setAttribute("aria-label", t(dark ? "themeToLight" : "themeToDark"));
    const eye = byId("password-eye");
    eye?.setAttribute("aria-label", t(eye.getAttribute("aria-pressed") === "true" ? "passwordHide" : "passwordShow"));
  };

  const renderContext = (): void => {
    // Which API this page signs in against: dev and preprod are badged,
    // production is not (the window title and the tray say the same).
    const badge = byId("env-badge");
    const environment = context?.environment;
    if (badge) {
      badge.hidden = !environment || environment === "prod";
      if (environment && environment !== "prod") {
        badge.dataset.environment = environment;
        badge.textContent = t(environment === "preprod" ? "envPreprod" : "envDev");
      }
    }
    const loading = byId("providers-loading");
    if (loading) {
      loading.hidden = contextSettled && context?.providers !== null;
      loading.textContent = contextSettled ? t("unreachable") : t("loading");
      loading.dataset.tone = contextSettled ? "danger" : "neutral";
    }
    const google = context?.providers?.google;
    const disabled = byId("google-disabled");
    if (google && !google.enabled) {
      document.body.dataset.google = "off";
      if (disabled) {
        disabled.hidden = false;
        disabled.textContent = t(google.reason === "origin_unsupported" ? "googleDisabledOriginUnsupported" : "googleDisabledNotConfigured");
      }
    } else {
      delete document.body.dataset.google;
      if (disabled) disabled.hidden = true;
    }

    // E-mail and password: off in production (signin-context.ts), unless
    // Google is off there too. Unknown providers keep the page as loaded.
    const password = context?.providers?.password;
    if (password) {
      if (password.enabled) delete document.body.dataset.password;
      else document.body.dataset.password = "off";
    }

    // Seeded development accounts, as on the console's /login.
    const dev = byId("dev-accounts");
    const list = byId("dev-list");
    const accounts = context?.providers?.devAccounts ?? [];
    if (dev && list) {
      dev.hidden = accounts.length === 0;
      list.replaceChildren(
        ...accounts.map((account) => {
          const role = t(account.role === "agency" ? "devRoleAgency" : "devRoleOwner");
          const row = document.createElement("div");
          row.className = "dev-choice";
          const roleLine = document.createElement("p");
          roleLine.className = "dev-role";
          roleLine.textContent = role;
          const emailLine = document.createElement("p");
          emailLine.className = "dev-account";
          emailLine.textContent = account.email;
          const actions = document.createElement("div");
          actions.className = "dev-actions";
          const fillButton = document.createElement("button");
          fillButton.type = "button";
          fillButton.className = "btn-text dev-fill";
          fillButton.textContent = t("devFill");
          fillButton.addEventListener("click", () => fillAccount(account.email, account.password));
          const submitButton = document.createElement("button");
          submitButton.type = "button";
          submitButton.className = "btn btn-primary dev-submit";
          // The role is already on the line above: a short label keeps the
          // row on one line, the accessible name still says which account.
          submitButton.textContent = t("passwordSubmit");
          submitButton.setAttribute("aria-label", t("devSubmitAs", { role }));
          submitButton.addEventListener("click", () => {
            fillAccount(account.email, account.password);
            void ipcRenderer.invoke(CHANNEL.authPassword, { email: account.email, password: account.password });
          });
          actions.append(fillButton, submitButton);
          row.append(roleLine, emailLine, actions);
          return row;
        }),
      );
    }

    // Legal pages the deployment serves, opened in the system browser.
    const nav = byId("legal-links");
    const slugs = context?.legal ?? [];
    if (nav) {
      nav.hidden = slugs.length === 0;
      nav.replaceChildren(
        ...slugs.map((slug: LegalSlug) => {
          const link = document.createElement("button");
          link.type = "button";
          link.className = "legal-link";
          link.textContent = t(`legal.${slug}`);
          link.addEventListener("click", () => void ipcRenderer.invoke(CHANNEL.authOpenLegal, slug));
          return link;
        }),
      );
    }
  };

  const fillAccount = (email: string, password: string): void => {
    const emailInput = byId<HTMLInputElement>("password-email");
    const secretInput = byId<HTMLInputElement>("password-secret");
    if (emailInput) emailInput.value = email;
    if (secretInput) secretInput.value = password;
    // Programmatic values fire no input event: drop the challenge the same way.
    emailInput?.dispatchEvent(new Event("input"));
  };

  const render = (): void => {
    const google = byId<HTMLButtonElement>("google-button");
    const submit = byId<HTMLButtonElement>("password-submit");
    const note = byId("signin-note");
    const codeField = byId<HTMLDivElement>("password-code-field");
    const codeInput = byId<HTMLInputElement>("password-code");
    const resendCode = byId<HTMLButtonElement>("password-code-resend");
    if (!google || !submit || !note || !codeField || !codeInput || !resendCode) return;
    // Templates show the Google pending block or the buttons from this.
    document.body.dataset.state = state.status;
    const submitting = state.status === "submitting";
    google.disabled = submitting;
    submit.disabled = submitting;
    codeField.hidden = !passwordCodeRequired;
    codeInput.disabled = !passwordCodeRequired || submitting;
    codeInput.required = passwordCodeRequired;
    resendCode.disabled = submitting;
    submit.textContent = t(submitting ? "passwordSubmitting" : passwordCodeRequired ? "passwordCodeVerify" : "passwordSubmit");

    let message = "";
    let tone = "neutral";
    if (state.status === "error") {
      const known = MESSAGES[locale][`failed.${state.code}`];
      message = known ? fill(known, state.params) : state.message;
      tone = "danger";
    } else if (state.status === "idle" && state.reason === "session-lost") {
      message = t("sessionLost");
      tone = "warning";
    } else if (state.status === "idle" && state.reason === "signed-out") {
      message = t("signedOut");
    }
    note.textContent = message;
    note.hidden = message === "";
    note.dataset.tone = tone;
  };

  const renderAll = (): void => {
    renderStatic();
    renderContext();
    render();
  };

  ipcRenderer.on(CHANNEL.authState, (_event, next: SigninState) => {
    state = next;
    if (next.status === "code_required") passwordCodeRequired = true;
    if (next.status === "idle") passwordCodeRequired = false;
    render();
  });

  window.addEventListener("DOMContentLoaded", () => {
    // Template: the stylesheet named in the query (window.ts validated it
    // exists). The page shows once it is in, or after a beat if it never
    // comes. The preload runs before the document exists, hence here.
    const query = new URLSearchParams(window.location.search);
    const template = query.get("template") ?? "";
    // Production: no e-mail form until the providers say otherwise (renderContext).
    if (query.get("password") === "off") document.body.dataset.password = "off";
    const ready = (): void => root().setAttribute("data-ready", "");
    // The page cannot know it runs under macOS's hidden title bar (window.ts):
    // signin-base.css keys the drag strip and the traffic-light corner on this.
    root().dataset.platform = process.platform;
    window.setTimeout(ready, 1500);
    if (TEMPLATE_PATTERN.test(template)) {
      root().dataset.template = template;
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = `templates/${template}.css`;
      link.addEventListener("load", ready);
      link.addEventListener("error", ready);
      document.head.append(link);
    } else {
      ready();
    }

    // Theme: the stored choice, or the system's.
    const storedTheme = storedValue(THEME_KEY);
    root().dataset.themeMode = storedTheme === "light" || storedTheme === "dark" ? storedTheme : "system";
    root().dataset.theme = storedTheme === "light" || storedTheme === "dark"
      ? storedTheme
      : window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";

    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event) => {
      if (root().dataset.themeMode !== "system") return;
      root().dataset.theme = event.matches ? "dark" : "light";
      renderStatic();
    });

    renderAll();
    void (ipcRenderer.invoke(CHANNEL.authContext) as Promise<SigninContext>)
      .then((result) => {
        context = result;
      })
      .catch(() => {
        // Tier unknown: no badge rather than a wrong one.
        context = { providers: null, legal: [], environment: "prod" };
      })
      .finally(() => {
        contextSettled = true;
        renderContext();
      });

    byId("google-button")?.addEventListener("click", () => {
      void ipcRenderer.invoke(CHANNEL.authStart);
    });
    byId("google-cancel")?.addEventListener("click", () => {
      void ipcRenderer.invoke(CHANNEL.authCancel);
    });

    for (const option of document.querySelectorAll<HTMLButtonElement>(".locale-option")) {
      option.addEventListener("click", () => {
        locale = option.dataset.locale === "en" ? "en" : "fr";
        store(LOCALE_KEY, locale);
        renderAll();
      });
    }
    byId("theme-toggle")?.addEventListener("click", () => {
      const next = root().dataset.theme === "dark" ? "light" : "dark";
      root().dataset.theme = next;
      root().dataset.themeMode = next;
      store(THEME_KEY, next);
      renderStatic();
    });

    const form = byId<HTMLFormElement>("password-form");
    const email = byId<HTMLInputElement>("password-email");
    const password = byId<HTMLInputElement>("password-secret");
    const codeInput = byId<HTMLInputElement>("password-code");
    const eye = byId<HTMLButtonElement>("password-eye");
    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!email || !password) return;
      // The eye does not survive a submission: a password shown on screen
      // after the fact is one that lingers (same rule as the console).
      password.type = "password";
      eye?.setAttribute("aria-pressed", "false");
      renderStatic();
      void ipcRenderer.invoke(CHANNEL.authPassword, {
        email: email.value,
        password: password.value,
        ...(passwordCodeRequired && codeInput ? { emailCode: codeInput.value } : {}),
      });
    });
    // A code challenge belongs to the address and password that raised it:
    // editing either drops it, so the next submit asks for a fresh code
    // instead of checking an old code against other credentials.
    const dropChallenge = (): void => {
      if (!passwordCodeRequired) return;
      passwordCodeRequired = false;
      if (codeInput) codeInput.value = "";
      render();
    };
    email?.addEventListener("input", dropChallenge);
    password?.addEventListener("input", dropChallenge);
    byId<HTMLButtonElement>("password-code-resend")?.addEventListener("click", () => {
      if (!email || !password) return;
      void ipcRenderer.invoke(CHANNEL.authPassword, { email: email.value, password: password.value });
    });
    eye?.addEventListener("click", () => {
      if (!password) return;
      const shown = password.type === "password";
      password.type = shown ? "text" : "password";
      eye.setAttribute("aria-pressed", String(shown));
      renderStatic();
    });
  });
}
