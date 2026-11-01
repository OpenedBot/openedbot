import { app, Menu, nativeImage, Tray } from "electron";
import type { DisplayMode } from "./preferences";
import { TRAY_ICON_16_BASE64, TRAY_ICON_32_BASE64 } from "./tray-icons";
import type { ShellWindow } from "./window";

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
};

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
    app.dock?.setMenu(
      Menu.buildFromTemplate([
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
  tray.setToolTip(options.targetLabel ? `openedbot (${options.targetLabel})` : "openedbot");

  const refresh = (): void => {
    tray.setContextMenu(
      Menu.buildFromTemplate([
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
