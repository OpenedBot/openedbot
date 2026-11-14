import { commands, events, type Level, type Source } from "@openedbot/contracts-native-bridge";

/**
 * `<html data-openedbot-titlebar-anchor>`: where the frame wants the macOS
 * traffic lights, `"card"` (the rail shell: the conversations card's head
 * row) or `"bar"` (the top bar). Set by `BoardFrame`, read below (`syncTitlebarAnchor`).
 * It lives here, not in `native-titlebar.ts`: that module imports the native
 * bridge, which imports this one (no-circular).
 */
export const TITLEBAR_ANCHOR_ATTRIBUTE = "data-openedbot-titlebar-anchor";

/**
 * What the page does for the Tauri app: the embedded console tells the shell its theme and its text size, serves as
 * title bar (WKWebView ignores `-webkit-app-region`) and hands it its
 * errors for the SQLite log (`diagnostics.rs`). Everything goes through the
 * bridge's typed commands (`@openedbot/contracts-native-bridge`).
 *
 * Enters only the desktop build, via `tauri-bridge.ts`: no effect on
 * module load, everything starts from `installTauriShell`.
 */

/** `<html data-openedbot-text-zoom>` (`lib/shell/text-size.ts`): the factor the console wants. */
const TEXT_ZOOM_ATTRIBUTE = "data-openedbot-text-zoom";
/** The text sizes (10 to 14 px) as zoom factors, like `TEXT_ZOOM_SIZES` of `prefs.rs`. */
export const TEXT_ZOOM_FACTORS = [10, 11, 12, 13, 14].map((size) => size / 14);

/**
 * The zones that move the window (`styles/components/native-titlebar.css`),
 * and what stays clickable there. The top band (`data-native-titlebar-band`)
 * receives no click: it is read at the pointer's height.
 */
const DRAG_REGIONS = "[data-titlebar-drag], [data-onboarding-titlebar]";
const NO_DRAG = [
  "a", "button", "input", "label", "select", "summary", "textarea", "[contenteditable='true']",
  "[role='button']", "[role='combobox']", "[role='link']", "[role='menuitem']", "[role='switch']", "[role='tab']",
  "[tabindex]:not([tabindex='-1'])", "[data-radix-popper-content-wrapper]", "[role='alertdialog']", "[role='dialog']",
  "[role='listbox']", "[role='menu']",
].join(", ");
/** The band from `native-titlebar.css`: 20 px, the whole bar (46 px) under 768 px wide. */
const BAND_HEIGHT = 20;
const NARROW_BAND_HEIGHT = 46;
const NARROW_WIDTH = 768;

const MAX_REPORT = 2000;

function report(level: Level, source: Source, message: string, detail: string | null = null): void {
  // The log is never a cause of error: a refusal from the shell is forgotten.
  void commands.reportDiagnostic(level, source, message.slice(0, MAX_REPORT), detail?.slice(0, MAX_REPORT) ?? null).catch(() => undefined);
}

/** The origin and the path, never the query: an OAuth code can sit there. */
export function pathOnly(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

/** The requested theme (and not the resolved color): « system » follows macOS. */
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
 * The factor requested by the console, if it is one of the five; 1 for an
 * unknown value; `null` until the console has set it (at startup,
 * the shell then keeps the last launch's zoom instead of going back to 1).
 */
export function textZoomOf(root: HTMLElement): number | null {
  const raw = root.getAttribute(TEXT_ZOOM_ATTRIBUTE);
  if (raw === null) return null;
  const zoom = Number(raw);
  return TEXT_ZOOM_FACTORS.find((factor) => Math.abs(factor - zoom) < 1e-9) ?? 1;
}

/** The anchor the frame asks for, or `null` before a frame has set one. */
export function titlebarAnchorOf(root: HTMLElement): "card" | "bar" | null {
  const raw = root.getAttribute(TITLEBAR_ANCHOR_ATTRIBUTE);
  if (raw === null) return null;
  return raw === "card" ? "card" : "bar";
}

/**
 * The traffic lights follow the frame (`BoardFrame`): in the conversations
 * card's head row (rail shell) or on the top bar. Nothing is sent until a
 * frame has set the attribute: the shell keeps the last launch's anchor.
 */
function syncTitlebarAnchor(root: HTMLElement): void {
  let last: "card" | "bar" | null = null;
  const sync = () => {
    const anchor = titlebarAnchorOf(root);
    if (anchor === null || anchor === last) return;
    last = anchor;
    void commands.setTitlebarAnchor(anchor).catch(() => {
      last = null;
    });
  };
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: [TITLEBAR_ANCHOR_ATTRIBUTE] });
  sync();
}

/**
 * The shell zooms the window (`set_zoom`) and keeps the factor for the
 * next launch: it is the only place it applies. The page sets
 * `data-native-zoom` and `--openedbot-native-zoom` at once, which
 * `native-titlebar.css` reads for the traffic lights' room; the shell sets them
 * again with the zoom actually in force (View menu included) on
 * each change and after each load.
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

/** True when a press at these coordinates must move the window. */
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
    // A double click on a title bar maximizes the window, as everywhere on macOS.
    void (event.detail === 2 ? commands.toggleMaximize() : commands.startWindowDrag()).catch(() => undefined);
  }, true);
}

/**
 * The page's errors and the API calls that fail (response ≥ 400,
 * or no response), for the shell's log. The messages are redacted
 * on the Rust side.
 */
function installDiagnostics(win: Window, apiOrigin: string): void {
  win.addEventListener("error", (event) => {
    report("error", "page", event.message || "error", event.filename ? `${pathOnly(event.filename)}:${event.lineno}` : null);
  });
  win.addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event.reason;
    report("error", "page", reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason));
  });
  // The page's `console`: `globalThis`'s (the DOM's `Window` type does not carry it).
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
      // A request the page abandons itself (navigation, closed stream) is not a failure.
      if (watched && !(error instanceof DOMException && error.name === "AbortError")) {
        report("error", "http", `${method} ${new URL(url).pathname} ${error instanceof Error ? error.name : "error"}`, "fetch");
      }
      throw error;
    }
  };
}

/** The notifications kept for their click: the most recent. */
const TRACKED_NOTIFICATIONS = 50;
const MAX_NOTIFICATION_ID = 2_147_483_647;

type PluginNotification = {
  (title: string, options: { body?: string; id: number }): void;
  readonly permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
};

/**
 * The `tauri-plugin-notification` polyfill replaces `Notification` with a
 * function that only calls `notify`: neither `close()` nor `onclick`. We
 * wrap it: each notification gets an identifier (drawn at random on
 * each load, so a click on a notification from before does not land
 * on another), the shell returns the system click
 * (`notificationClicked`) and the page calls its `onclick`, which opens the
 * conversation. `close()` forgets it; macOS keeps the notification shown.
 */
export function bridgeNotifications(win: Window, onClicked: (listener: (id: number) => void) => void): void {
  const plugin = (win as unknown as { Notification?: PluginNotification }).Notification;
  if (typeof plugin !== "function") return;
  const shown = new Map<number, ShellNotification>();
  let next = Math.floor(Math.random() * (MAX_NOTIFICATION_ID / 2));

  // The polyfill sets `window.Notification.permission` when it learns it:
  // on this wrapper, from now on. Before that, its own stands.
  let permission: NotificationPermission | null = null;

  // Only `onclick` is relayed: that is what the console sets.
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
      // The title and the text only: nothing else goes to the system.
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
  syncTitlebarAnchor(root);
  installDragRegions(win.document);
  installDiagnostics(win, apiOrigin);
  bridgeNotifications(win, (listener) => {
    void events.notificationClicked.listen((event) => listener(event.payload.id)).catch(() => undefined);
  });
}
