import { app, BrowserWindow, clipboard, Menu, type MenuItemConstructorOptions } from "electron";
import { isElectronViteDev } from "./dev-reload";

// Electron shows no context menu at all: without this one, a right click in
// the composer, on a message or on a spelling mistake does nothing, where any
// desktop app offers copy, paste and the spelling suggestions. The menu only
// edits, copies or corrects: it never opens a URL or navigates (links already
// go to the system browser on click, window.ts), so it widens nothing.

type Locale = "fr" | "en";

const LABELS: Record<Locale, Record<string, string>> = {
  fr: {
    noSuggestion: "Aucune suggestion",
    learnSpelling: "Ajouter au dictionnaire",
    undo: "Annuler",
    redo: "Rétablir",
    cut: "Couper",
    copy: "Copier",
    paste: "Coller",
    selectAll: "Tout sélectionner",
    copyLink: "Copier l’adresse du lien",
    copyImage: "Copier l’image",
    inspect: "Inspecter l’élément",
  },
  en: {
    noSuggestion: "No suggestions",
    learnSpelling: "Add to dictionary",
    undo: "Undo",
    redo: "Redo",
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    selectAll: "Select all",
    copyLink: "Copy link address",
    copyImage: "Copy image",
    inspect: "Inspect element",
  },
};

/** Spelling suggestions shown at most, as in Chrome. */
const MAX_SUGGESTIONS = 5;

function locale(): Locale {
  return app.getLocale().toLowerCase().startsWith("fr") ? "fr" : "en";
}

/** Only web links are worth copying: no `javascript:`, `file:` or app scheme. */
function webLink(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Groups separated once, without a leading, trailing or doubled separator. */
function joinGroups(groups: MenuItemConstructorOptions[][]): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  for (const group of groups) {
    if (group.length === 0) continue;
    if (items.length > 0) items.push({ type: "separator" });
    items.push(...group);
  }
  return items;
}

export function buildContextMenu(contents: Electron.WebContents, params: Electron.ContextMenuParams): MenuItemConstructorOptions[] {
  const t = LABELS[locale()];
  const flags = params.editFlags;

  const spelling: MenuItemConstructorOptions[] = [];
  if (params.isEditable && params.misspelledWord) {
    const suggestions = params.dictionarySuggestions.slice(0, MAX_SUGGESTIONS);
    if (suggestions.length === 0) spelling.push({ label: t.noSuggestion, enabled: false });
    for (const suggestion of suggestions) {
      spelling.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) });
    }
    const word = params.misspelledWord;
    spelling.push({ label: t.learnSpelling, click: () => contents.session.addWordToSpellCheckerDictionary(word) });
  }

  const history: MenuItemConstructorOptions[] = params.isEditable
    ? [
        { label: t.undo, role: "undo", enabled: flags.canUndo },
        { label: t.redo, role: "redo", enabled: flags.canRedo },
      ]
    : [];

  // A password never reaches the system clipboard from this menu, whatever
  // Chromium's flags say (the sign-in page has one). Read-only text: Copy
  // only when something is selected, otherwise the menu would be a column of
  // disabled items on every right click.
  const password = params.formControlType === "input-password";
  const clipboardItems: MenuItemConstructorOptions[] = params.isEditable
    ? [
        ...(password
          ? []
          : [
              { label: t.cut, role: "cut", enabled: flags.canCut } as const,
              { label: t.copy, role: "copy", enabled: flags.canCopy } as const,
            ]),
        { label: t.paste, role: "paste", enabled: flags.canPaste },
        { label: t.selectAll, role: "selectAll", enabled: flags.canSelectAll },
      ]
    : params.selectionText.trim()
      ? [{ label: t.copy, role: "copy", enabled: flags.canCopy }]
      : [];

  const target: MenuItemConstructorOptions[] = [];
  const link = params.linkURL ? webLink(params.linkURL) : null;
  if (link) target.push({ label: t.copyLink, click: () => clipboard.writeText(link) });
  if (params.mediaType === "image" && params.hasImageContents) {
    const { x, y } = params;
    target.push({ label: t.copyImage, click: () => contents.copyImageAt(x, y) });
  }

  // Development only: a packaged build has no DevTools to open.
  const dev: MenuItemConstructorOptions[] = isElectronViteDev
    ? [{ label: t.inspect, click: () => contents.inspectElement(params.x, params.y) }]
    : [];

  return joinGroups([spelling, history, clipboardItems, target, dev]);
}

/** Pops the menu on every right click (or Ctrl+click on macOS) in the window. */
export function installContextMenu(contents: Electron.WebContents): void {
  contents.on("context-menu", (_event, params) => {
    const items = buildContextMenu(contents, params);
    if (items.length === 0) return;
    const window = BrowserWindow.fromWebContents(contents);
    Menu.buildFromTemplate(items).popup(window ? { window } : undefined);
  });
}
