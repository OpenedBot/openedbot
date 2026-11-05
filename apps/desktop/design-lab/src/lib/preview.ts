import messages from "../../../src/renderer/signin-messages.json";

/*
  Drives the real signin.html inside an iframe the way the app's preload
  does (src/preload/preload.ts): template stylesheet, theme, language and the
  sign-in state. The page forbids scripts (CSP), so the lab works from the
  parent, on the same origin. The copy comes from the same JSON as the app.
*/

export type Theme = "dark" | "light";
export type Locale = "fr" | "en";
export type PreviewState =
  | "idle"
  | "signedOut"
  | "sessionLost"
  | "loading"
  | "waiting"
  | "submitting"
  | "error"
  | "googleOff"
  | "unreachable"
  | "devAccounts";

export const STATES: Array<{ id: PreviewState; label: string }> = [
  { id: "idle", label: "Repos" },
  { id: "signedOut", label: "Déconnecté" },
  { id: "sessionLost", label: "Session expirée" },
  { id: "loading", label: "Chargement" },
  { id: "waiting", label: "Attente Google" },
  { id: "submitting", label: "Connexion…" },
  { id: "error", label: "Erreur" },
  { id: "googleOff", label: "Google indisponible" },
  { id: "unreachable", label: "API muette" },
  { id: "devAccounts", label: "Comptes de dev" },
];

export const SIZES: Array<{ id: string; width: number; height: number; label: string }> = [
  { id: "1280x820", width: 1280, height: 820, label: "1280 × 820 (défaut)" },
  { id: "1440x900", width: 1440, height: 900, label: "1440 × 900" },
  { id: "1700x1050", width: 1700, height: 1050, label: "1700 × 1050" },
  { id: "1000x560", width: 1000, height: 560, label: "1000 × 560" },
  { id: "1600x650", width: 1600, height: 650, label: "1600 × 650 (large, bas)" },
  { id: "820x1000", width: 820, height: 1000, label: "820 × 1000 (étroit, haut)" },
  { id: "800x560", width: 800, height: 560, label: "800 × 560 (minimum)" },
];

export type PreviewOptions = {
  template: string;
  theme: Theme;
  locale: Locale;
  state: PreviewState;
  /** Bumped when a renderer file changes, to bust the stylesheet cache. */
  revision: number;
};

type Messages = Record<string, string>;
const COPY = messages as Record<Locale, Messages>;

const DEV_ACCOUNTS = [
  { email: "dev@openedbot.local", role: "owner" as const },
  { email: "agency@openedbot.local", role: "agency" as const },
];

function t(locale: Locale, key: string, params: Record<string, string> = {}): string {
  const text = COPY[locale][key] ?? COPY.fr[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match);
}

/** Applies template, theme, language and state to the preview document. */
export function applyPreview(doc: Document, options: PreviewOptions): void {
  const root = doc.documentElement;
  const body = doc.body;
  if (!body) return;
  const byId = (id: string): HTMLElement | null => doc.getElementById(id);
  const { locale, state } = options;

  // Template stylesheet, the way the preload adds it; the page shows once it is in.
  const href = `templates/${options.template}.css?rev=${options.revision}`;
  let link = doc.getElementById("lab-template") as HTMLLinkElement | null;
  if (!link) {
    link = doc.createElement("link");
    link.id = "lab-template";
    link.rel = "stylesheet";
    doc.head.append(link);
  }
  if (!link.href.endsWith(href)) {
    root.removeAttribute("data-ready");
    link.addEventListener("load", () => root.setAttribute("data-ready", ""), { once: true });
    link.addEventListener("error", () => root.setAttribute("data-ready", ""), { once: true });
    link.href = href;
  }
  root.dataset.template = options.template;
  root.dataset.theme = options.theme;
  root.lang = locale;

  for (const element of doc.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = element.dataset.i18n;
    if (key) element.textContent = t(locale, key);
  }
  for (const element of doc.querySelectorAll<HTMLElement>("[data-i18n-label]")) {
    const key = element.dataset.i18nLabel;
    if (key) element.setAttribute("aria-label", t(locale, key));
  }
  for (const option of doc.querySelectorAll<HTMLElement>(".locale-option")) {
    option.setAttribute("aria-pressed", String(option.dataset.locale === locale));
  }
  byId("theme-toggle")?.setAttribute("aria-checked", String(options.theme === "dark"));

  // Back to a clean page, then the requested state.
  body.dataset.state = "idle";
  delete body.dataset.google;
  const note = byId("signin-note");
  const loading = byId("providers-loading");
  const googleOff = byId("google-disabled");
  const submit = byId("password-submit") as HTMLButtonElement | null;
  const google = byId("google-button") as HTMLButtonElement | null;
  const dev = byId("dev-accounts");
  const devList = byId("dev-list");
  const legal = byId("legal-links");
  if (note) note.hidden = true;
  if (loading) loading.hidden = true;
  if (googleOff) googleOff.hidden = true;
  if (dev) dev.hidden = true;
  if (submit) {
    submit.disabled = false;
    submit.textContent = t(locale, "passwordSubmit");
  }
  if (google) google.disabled = false;

  const showNote = (text: string, tone: "neutral" | "warning" | "danger"): void => {
    if (!note) return;
    note.textContent = text;
    note.dataset.tone = tone;
    note.hidden = false;
  };

  switch (state) {
    case "signedOut":
      showNote(t(locale, "signedOut"), "neutral");
      break;
    case "sessionLost":
      showNote(t(locale, "sessionLost"), "warning");
      break;
    case "loading":
      if (loading) {
        loading.hidden = false;
        loading.textContent = t(locale, "loading");
        loading.dataset.tone = "neutral";
      }
      break;
    case "waiting":
      body.dataset.state = "waiting";
      break;
    case "submitting":
      body.dataset.state = "submitting";
      if (submit) {
        submit.disabled = true;
        submit.textContent = t(locale, "passwordSubmitting");
      }
      if (google) google.disabled = true;
      break;
    case "error":
      body.dataset.state = "error";
      showNote(t(locale, "failed.CREDENTIALS_INVALID"), "danger");
      break;
    case "googleOff":
      body.dataset.google = "off";
      if (googleOff) {
        googleOff.hidden = false;
        googleOff.textContent = t(locale, "googleDisabledNotConfigured");
      }
      break;
    case "unreachable":
      if (loading) {
        loading.hidden = false;
        loading.textContent = t(locale, "unreachable");
        loading.dataset.tone = "danger";
      }
      break;
    case "devAccounts":
      if (dev && devList) {
        dev.hidden = false;
        devList.replaceChildren(
          ...DEV_ACCOUNTS.map((account) => {
            const role = t(locale, account.role === "agency" ? "devRoleAgency" : "devRoleOwner");
            const row = doc.createElement("div");
            row.className = "dev-choice";
            const roleLine = doc.createElement("p");
            roleLine.className = "dev-role";
            roleLine.textContent = role;
            const emailLine = doc.createElement("p");
            emailLine.className = "dev-account";
            emailLine.textContent = account.email;
            const actions = doc.createElement("div");
            actions.className = "dev-actions";
            const fill = doc.createElement("button");
            fill.type = "button";
            fill.className = "btn-text dev-fill";
            fill.textContent = t(locale, "devFill");
            const go = doc.createElement("button");
            go.type = "button";
            go.className = "btn btn-primary dev-submit";
            // Mirrors the preload: short label, the role in the accessible name.
            go.textContent = t(locale, "passwordSubmit");
            go.setAttribute("aria-label", t(locale, "devSubmitAs", { role }));
            actions.append(fill, go);
            row.append(roleLine, emailLine, actions);
            return row;
          }),
        );
      }
      break;
    case "idle":
      break;
  }

  // Two legal links, as a deployment that serves them would show.
  if (legal) {
    legal.hidden = false;
    legal.replaceChildren(
      ...["mentions", "privacy"].map((slug) => {
        const button = doc.createElement("button");
        button.type = "button";
        button.className = "legal-link";
        button.textContent = t(locale, `legal.${slug}`);
        return button;
      }),
    );
  }
}

export type LayoutCheck = { label: string; ok: boolean };

/**
 * The same layout checks as /tmp/openedbot-e2e/gallery.ts: the template applied, the
 * submit button and the language/theme switches on screen, no horizontal
 * scroll, no key element overlapping another.
 */
export function checkLayout(win: Window): LayoutCheck[] {
  const doc = win.document;
  const box = (selector: string): DOMRect | undefined => doc.querySelector(selector)?.getBoundingClientRect();
  const keys = ["h1.title", ".lead", "#google-button", "#password-email", "#password-secret", "#password-submit", ".locale", "#theme-toggle"];
  const rects = keys
    .map((key) => [key, box(key)] as const)
    .filter((entry): entry is readonly [string, DOMRect] => !!entry[1] && entry[1].width > 0 && entry[1].height > 0);
  const overlaps: string[] = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const [a, ra] = rects[i]!;
      const [b, rb] = rects[j]!;
      if (ra.left < rb.right - 1 && ra.right > rb.left + 1 && ra.top < rb.bottom - 1 && ra.bottom > rb.top + 1) overlaps.push(`${a} / ${b}`);
    }
  }
  const submit = box("#password-submit");
  const controls = box(".controls");
  const onScreen = (rect: DOMRect | undefined): boolean => !!rect && rect.width > 0 && rect.top >= 0 && rect.bottom <= win.innerHeight;
  return [
    { label: "Template appliqué", ok: [...doc.styleSheets].some((sheet) => sheet.href?.includes("/templates/")) },
    { label: "« Se connecter » visible sans défiler", ok: onScreen(submit) || doc.body.dataset.state === "waiting" },
    { label: "Langue et thème visibles sans défiler", ok: onScreen(controls) },
    { label: "Pas de défilement horizontal", ok: doc.documentElement.scrollWidth <= win.innerWidth + 1 },
    { label: overlaps.length ? `Chevauchement : ${overlaps.join(", ")}` : "Aucun chevauchement", ok: overlaps.length === 0 },
  ];
}
