import {
  DEFAULT_THEME,
  MEDIA_DARK,
  THEME_ACCENT_ATTR,
  THEME_MODE_ATTR,
  THEME_STORAGE_KEY,
  normalizeTheme,
  type Theme,
} from "./config"

/**
 * Reads the persisted theme. Never throws: a WebView with storage disabled, or
 * a key left over from an older shape, must not keep the window from painting.
 */
export function readStoredTheme(): Theme {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (!raw) return DEFAULT_THEME
    return normalizeTheme(JSON.parse(raw))
  } catch {
    return DEFAULT_THEME
  }
}

export function writeStoredTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(theme))
  } catch {
    // A theme that fails to persist is a lost preference, not a broken app.
  }
}

/**
 * Paints the stored theme onto <html>, synchronously, before React renders.
 *
 * This used to be a source string executed from `index.html` via
 * `new Function(...)`. That is `eval`, and a `default-src 'self'` policy with
 * no `'unsafe-eval'` made the call throw an EvalError at the top of the entry
 * chunk, aborting the whole module: React never mounted and the page rendered
 * blank white, while `vite dev` (no CSP) looked fine. Plain code, called from
 * the entry, has no such problem.
 */
export function paintStoredTheme(): void {
  const theme = readStoredTheme()
  const root = document.documentElement
  root.setAttribute(THEME_MODE_ATTR, theme.mode)
  root.setAttribute(THEME_ACCENT_ATTR, theme.accent)

  const dark =
    theme.mode === "dark" ||
    (theme.mode === "system" && window.matchMedia(MEDIA_DARK).matches)
  root.classList.toggle("dark", dark)
}
