import { app, Menu, nativeImage, Tray } from "electron";
import type { DisplayMode } from "./preferences";
import { TRAY_ICON_16_BASE64, TRAY_ICON_32_BASE64 } from "./tray-icons";
import type { ShellWindow } from "./window";
import { yoloStatusLabel, type YoloSnapshot } from "./yolo";

export type ShellTray = {
  /** Rebuilds the menu so checkbox and enabled states follow the app state. */
  refresh(): void;
  destroy(): void;
};

export type TrayOptions = {
  window: ShellWindow;
  isSignedIn(): boolean;
  onSignOut(): void;
  onQuit(): void;
  /** Set when the shell is not aimed at production (see target.ts): appended to the tooltip. */
  targetLabel?: string | null;
  /** macOS only (the popup is the native openedbot Notch): window, popup or both. */
  displayMode?: {
    current(): DisplayMode;
    /** false when no popup bundle is found: the popup choices are greyed. */
    popupAvailable(): boolean;
    set(mode: DisplayMode): void;
  };
  /** YOLO badge, countdown and kill switch (yolo.ts). Granting stays in the console. */
  yolo?: {
    snapshot(): YoloSnapshot;
    /** Confirms natively, kills, reports: fire and forget. */
    killEverywhere(): void;
  };
};

/** The status line and "Couper YOLO partout", signed in only. */
function yoloItems(options: TrayOptions): Electron.MenuItemConstructorOptions[] {
  const yolo = options.yolo;
  if (!yolo || !options.isSignedIn()) return [];
  const state = yolo.snapshot();
  const status = yoloStatusLabel(state, Date.now());
  const items: Electron.MenuItemConstructorOptions[] = [];
  if (status) items.push({ label: status, enabled: false });
  // Shown with no live lease too: a host may hold one the cloud believes over,
  // and the kill reaches every runtime anyway. Hidden after a 403 (not owner or admin).
  if (state.canKill) {
    items.push({
      label: state.killing ? "Coupure de YOLO…" : "Couper YOLO partout…",
      enabled: !state.killing,
      click: () => yolo.killEverywhere(),
    });
  }
  return items.length > 0 ? [...items, { type: "separator" }] : [];
}

function yoloStatus(options: TrayOptions): string | null {
  return options.yolo && options.isSignedIn() ? yoloStatusLabel(options.yolo.snapshot(), Date.now()) : null;
}

const DISPLAY_MODE_LABELS: ReadonlyArray<[DisplayMode, string]> = [
  ["window", "Fenêtre"],
  ["popup", "Popup"],
  ["both", "Fenêtre et popup"],
];

function displayModeItems(options: TrayOptions): Electron.MenuItemConstructorOptions[] {
  const mode = options.displayMode;
  if (!mode) return [];
  const available = mode.popupAvailable();
  return [
    { label: "Affichage", enabled: false },
    ...DISPLAY_MODE_LABELS.map(([value, label]): Electron.MenuItemConstructorOptions => ({
      label: value !== "window" && !available ? `${label} (popup introuvable)` : label,
      type: "radio",
      checked: mode.current() === value,
      enabled: value === "window" || available,
      click: () => mode.set(value),
    })),
    { type: "separator" },
  ];
}

function createIcon(): Electron.NativeImage {
  // Two representations so Windows picks the sharp one at 100% and 200% scaling.
  const icon = nativeImage.createEmpty();
  icon.addRepresentation({ scaleFactor: 1, width: 16, height: 16, buffer: Buffer.from(TRAY_ICON_16_BASE64, "base64") });
  icon.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: Buffer.from(TRAY_ICON_32_BASE64, "base64") });
  return icon;
}

/**
 * macOS: no menu bar icon. The Dock icon already is the app's handle (a click
 * reopens the window, see main.ts), and a second mascot in the menu bar did
 * nothing the Dock does not. Its options live in the Dock menu instead;
 * Show and Quit are already there, provided by macOS.
 */
function createDockMenu(options: TrayOptions): ShellTray {
  const refresh = (): void => {
    // The Dock badge is the macOS YOLO badge; the countdown is in the menu.
    app.dock?.setBadge(yoloStatus(options) ? "YOLO" : "");
    app.dock?.setMenu(
      Menu.buildFromTemplate([
        ...yoloItems(options),
        ...displayModeItems(options),
        {
          label: "Toujours au premier plan",
          type: "checkbox",
          checked: options.window.isAlwaysOnTop(),
          click: (item) => options.window.setAlwaysOnTop(item.checked),
        },
        { label: "Se déconnecter", enabled: options.isSignedIn(), click: () => options.onSignOut() },
      ]),
    );
  };
  refresh();
  return { refresh, destroy: () => {} };
}

export function createTray(options: TrayOptions): ShellTray {
  if (process.platform === "darwin") return createDockMenu(options);
  const tray = new Tray(createIcon());
  const baseTooltip = options.targetLabel ? `openedbot (${options.targetLabel})` : "openedbot";

  const refresh = (): void => {
    const status = yoloStatus(options);
    tray.setToolTip(status ? `${baseTooltip} · ${status}` : baseTooltip);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        ...yoloItems(options),
        { label: "Afficher / Masquer", click: () => options.window.toggle() },
        {
          label: "Toujours au premier plan",
          type: "checkbox",
          checked: options.window.isAlwaysOnTop(),
          click: (item) => options.window.setAlwaysOnTop(item.checked),
        },
        { type: "separator" },
        { label: "Se déconnecter", enabled: options.isSignedIn(), click: () => options.onSignOut() },
        { type: "separator" },
        { label: "Quitter", click: () => options.onQuit() },
      ]),
    );
  };

  // A plain click is the main gesture; the menu opens on right-click.
  tray.on("click", () => options.window.toggle());
  refresh();

  return { refresh, destroy: () => tray.destroy() };
}
