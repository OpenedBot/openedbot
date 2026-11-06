import { commands, events, type Level, type Source } from "@openedbot/contracts-native-bridge";

/**
 * Ce que la page fait pour l'app Tauri : la console embarquée dit à la coque son thème et sa taille de texte, sert de
 * barre de titre (WKWebView ignore `-webkit-app-region`) et lui confie ses
 * erreurs pour le journal SQLite (`diagnostics.rs`). Tout passe par les
 * commandes typées du pont (`@openedbot/contracts-native-bridge`).
 *
 * N'entre que dans le build desktop, par `tauri-bridge.ts` : aucun effet au
 * chargement du module, tout part de `installTauriShell`.
 */

/** `<html data-openedbot-text-zoom>` (`lib/shell/text-size.ts`) : le facteur voulu par la console. */
const TEXT_ZOOM_ATTRIBUTE = "data-openedbot-text-zoom";
/** Les tailles de texte (10 à 14 px) en facteurs de zoom, comme `TEXT_ZOOM_SIZES` de `prefs.rs`. */
export const TEXT_ZOOM_FACTORS = [10, 11, 12, 13, 14].map((size) => size / 14);

/**
 * Les zones qui déplacent la fenêtre (`styles/components/native-titlebar.css`),
 * et ce qui y reste cliquable. La bande du haut (`data-native-titlebar-band`)
 * ne reçoit aucun clic : elle se lit à la hauteur du pointeur.
 */
const DRAG_REGIONS = "[data-titlebar-drag], [data-onboarding-titlebar], [data-board-icon-rail] [data-titlebar-rail-logo]";
const NO_DRAG = [
  "a", "button", "input", "label", "select", "summary", "textarea", "[contenteditable='true']",
  "[role='button']", "[role='combobox']", "[role='link']", "[role='menuitem']", "[role='switch']", "[role='tab']",
  "[tabindex]:not([tabindex='-1'])", "[data-radix-popper-content-wrapper]", "[role='alertdialog']", "[role='dialog']",
  "[role='listbox']", "[role='menu']",
].join(", ");
/** La bande de `native-titlebar.css` : 20 px, la barre entière (46 px) sous 768 px de large. */
const BAND_HEIGHT = 20;
const NARROW_BAND_HEIGHT = 46;
const NARROW_WIDTH = 768;

const MAX_REPORT = 2000;

function report(level: Level, source: Source, message: string, detail: string | null = null): void {
  // Le journal n'est jamais une cause d'erreur : un refus de la coque s'oublie.
  void commands.reportDiagnostic(level, source, message.slice(0, MAX_REPORT), detail?.slice(0, MAX_REPORT) ?? null).catch(() => undefined);
}

/** L'origine et le chemin, jamais la requête : un code OAuth peut s'y trouver. */
export function pathOnly(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

/** Le thème demandé (et non la couleur résolue) : « system » suit macOS. */
export function themeModeOf(root: HTMLElement): "light" | "dark" | "system" {
  const requested = root.dataset.themeMode ?? root.dataset.theme;
  return requested === "light" || requested === "dark" ? requested : "system";
}

function syncTheme(root: HTMLElement): void {
  let last: string | null = null;
  const sync = () => {
    const mode = themeModeOf(root);
    if (mode === last) return;
    last = mode;
    void commands.setTheme(mode).catch(() => {
      last = null;
    });
  };
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["data-theme-mode", "data-theme"] });
  sync();
}

/**
 * Le facteur demandé par la console, s'il est l'un des cinq ; 1 pour une
 * valeur inconnue ; `null` tant que la console ne l'a pas posé (au démarrage,
 * la coque garde alors le zoom du dernier lancement au lieu de repasser à 1).
 */
export function textZoomOf(root: HTMLElement): number | null {
  const raw = root.getAttribute(TEXT_ZOOM_ATTRIBUTE);
  if (raw === null) return null;
  const zoom = Number(raw);
  return TEXT_ZOOM_FACTORS.find((factor) => Math.abs(factor - zoom) < 1e-9) ?? 1;
}

/**
 * La coque zoome la fenêtre (`set_zoom`) et retient le facteur pour le
 * prochain lancement : c'est le seul endroit où il s'applique. La page pose
 * aussitôt `data-native-zoom` et `--openedbot-native-zoom`, que
 * `native-titlebar.css` lit pour la place des feux tricolores ; la coque les
 * repose avec le zoom réellement en vigueur (menu View compris) à
 * chaque changement et après chaque chargement.
 */
function syncTextZoom(root: HTMLElement): void {
  let last: number | null = null;
  const sync = () => {
    const zoom = textZoomOf(root);
    if (zoom === null || zoom === last) return;
    last = zoom;
    root.setAttribute("data-native-zoom", "");
    root.style.setProperty("--openedbot-native-zoom", String(zoom));
    void commands.setTextZoom(zoom).then((outcome) => {
      if (outcome.status === "error") last = null;
    }, () => {
      last = null;
    });
  };
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: [TEXT_ZOOM_ATTRIBUTE] });
  sync();
}

/** Vrai quand un appui à ces coordonnées doit déplacer la fenêtre. */
export function startsWindowDrag(target: Element | null, clientY: number, viewportWidth: number, titlebar: boolean): boolean {
  if (!titlebar || !target || target.closest(NO_DRAG)) return false;
  const band = viewportWidth < NARROW_WIDTH ? NARROW_BAND_HEIGHT : BAND_HEIGHT;
  return clientY < band || target.closest(DRAG_REGIONS) !== null;
}

function installDragRegions(doc: Document): void {
  doc.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    const titlebar = doc.documentElement.hasAttribute("data-native-titlebar");
    if (!startsWindowDrag(event.target instanceof Element ? event.target : null, event.clientY, doc.documentElement.clientWidth, titlebar)) return;
    // Un double clic sur une barre de titre agrandit la fenêtre, comme partout sur macOS.
    void (event.detail === 2 ? commands.toggleMaximize() : commands.startWindowDrag()).catch(() => undefined);
  }, true);
}

/**
 * Les erreurs de la page et les appels à l'API qui échouent (réponse ≥ 400,
 * ou aucune réponse), pour le journal de la coque. Les messages sont expurgés
 * côté Rust.
 */
function installDiagnostics(win: Window, apiOrigin: string): void {
  win.addEventListener("error", (event) => {
    report("error", "page", event.message || "error", event.filename ? `${pathOnly(event.filename)}:${event.lineno}` : null);
  });
  win.addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event.reason;
    report("error", "page", reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason));
  });
  // `console` de la page : celui de `globalThis` (le type `Window` du DOM ne le porte pas).
  const pageConsole = globalThis.console;
  for (const level of ["error", "warn"] as const) {
    const original = pageConsole[level].bind(pageConsole);
    pageConsole[level] = (...args: unknown[]) => {
      original(...args);
      report(level, "page", args.map((value) => (value instanceof Error ? `${value.name}: ${value.message}` : String(value))).join(" "));
    };
  }
  if (!apiOrigin) return;
  const fetchFromPage = win.fetch.bind(win);
  win.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const watched = url.startsWith(`${apiOrigin}/`);
    try {
      const response = await fetchFromPage(input, init);
      if (watched && response.status >= 400) {
        report(response.status >= 500 ? "error" : "warn", "http", `${method} ${new URL(url).pathname} ${response.status}`, "fetch");
      }
      return response;
    } catch (error) {
      // Une requête que la page abandonne elle-même (navigation, flux fermé) n'est pas une panne.
      if (watched && !(error instanceof DOMException && error.name === "AbortError")) {
        report("error", "http", `${method} ${new URL(url).pathname} ${error instanceof Error ? error.name : "error"}`, "fetch");
      }
      throw error;
    }
  };
}

/** Les notifications retenues pour leur clic : les plus récentes. */
const TRACKED_NOTIFICATIONS = 50;
const MAX_NOTIFICATION_ID = 2_147_483_647;

type PluginNotification = {
  (title: string, options: { body?: string; id: number }): void;
  readonly permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
};

/**
 * Le polyfill de `tauri-plugin-notification` remplace `Notification` par une
 * fonction qui n'appelle que `notify` : ni `close()`, ni `onclick`. On
 * l'enveloppe : chaque notification reçoit un identifiant (tiré au hasard à
 * chaque chargement, pour qu'un clic sur une notification d'avant ne tombe
 * pas sur une autre), la coque renvoie le clic du système
 * (`notificationClicked`) et la page appelle son `onclick`, qui ouvre la
 * conversation. `close()` l'oublie ; macOS garde la notification affichée.
 */
export function bridgeNotifications(win: Window, onClicked: (listener: (id: number) => void) => void): void {
  const plugin = (win as unknown as { Notification?: PluginNotification }).Notification;
  if (typeof plugin !== "function") return;
  const shown = new Map<number, ShellNotification>();
  let next = Math.floor(Math.random() * (MAX_NOTIFICATION_ID / 2));

  // Le polyfill pose `window.Notification.permission` quand il l'apprend :
  // sur cette enveloppe, désormais. Avant cela, la sienne fait foi.
  let permission: NotificationPermission | null = null;

  // Seul `onclick` est relayé : c'est ce que la console pose.
  class ShellNotification {
    static get permission(): NotificationPermission {
      return permission ?? plugin!.permission;
    }
    static set permission(value: NotificationPermission) {
      permission = value;
    }
    static requestPermission(): Promise<NotificationPermission> {
      return plugin!.requestPermission();
    }
    onclick: ((this: ShellNotification, event: Event) => unknown) | null = null;
    readonly id: number;
    readonly title: string;
    readonly body: string;
    readonly tag: string;

    constructor(title: string, options: NotificationOptions = {}) {
      next = next >= MAX_NOTIFICATION_ID ? 1 : next + 1;
      this.id = next;
      this.title = title;
      this.body = options.body ?? "";
      this.tag = options.tag ?? "";
      shown.set(this.id, this);
      if (shown.size > TRACKED_NOTIFICATIONS) shown.delete(shown.keys().next().value!);
      // Le titre et le texte seulement : rien d'autre ne part vers le système.
      plugin!(title, { body: options.body, id: this.id });
    }

    close(): void {
      shown.delete(this.id);
    }
  }

  onClicked((id) => {
    const notification = shown.get(id);
    if (!notification) return;
    shown.delete(id);
    const event = new Event("click");
    notification.onclick?.call(notification, event);
  });
  (win as unknown as { Notification: unknown }).Notification = ShellNotification;
}

export function installTauriShell(win: Window, apiOrigin: string): void {
  const root = win.document.documentElement;
  syncTheme(root);
  syncTextZoom(root);
  installDragRegions(win.document);
  installDiagnostics(win, apiOrigin);
  bridgeNotifications(win, (listener) => {
    void events.notificationClicked.listen((event) => listener(event.payload.id)).catch(() => undefined);
  });
}
