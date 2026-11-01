/**
 * Theme configuration: single source of truth for the colour scheme and the
 * accent hue. Kept dependency-free on purpose (same idiom as `@/i18n/config`),
 * so the anti-flash script and the server functions can both import it.
 *
 * The accent ids match the `[data-accent="…"]` blocks in `styles/app.css`.
 */

export const THEME_MODES = ["light", "dark", "system"] as const

export type ThemeMode = (typeof THEME_MODES)[number]

/** What the shell renders once `system` has been resolved. */
export type ResolvedMode = "light" | "dark"

/**
 * Light, and not `system`. The console opens on a public waiting-list screen
 * whose artwork is a daylight sky: a visitor whose OS is dark got the night
 * version of a page that was designed for the day one. A preference already
 * stored still wins; only someone who never touched the switch sees light.
 */
export const DEFAULT_MODE: ThemeMode = "light"

export const ACCENTS = ["blue", "teal", "lime", "pink", "sky", "purple", "emerald", "yellow", "orange", "rose"] as const

export type AccentId = (typeof ACCENTS)[number]

export const DEFAULT_ACCENT: AccentId = "blue"

/** The 500 stop of each scale: drives the swatch in the picker, nothing else. */
export const ACCENT_SWATCHES: Record<AccentId, string> = {
  blue: "#3080ff",
  teal: "#00bba7",
  lime: "#7ccf00",
  pink: "#f6339a",
  sky: "#00a6f4",
  purple: "#ad46ff",
  emerald: "#00bc7d",
  yellow: "#efb100",
  orange: "#ff6900",
  rose: "#ff2056",
}

export type Theme = { mode: ThemeMode; accent: AccentId }

export const DEFAULT_THEME: Theme = { mode: DEFAULT_MODE, accent: DEFAULT_ACCENT }

/**
 * Where the theme persists across launches.
 *
 * It used to be a cookie, because the server rendered `<html className>` and
 * needed the choice on the request. There is no server render here: the SPA
 * is a static bundle, so `localStorage` is both the only channel available
 * and the one the head script can read synchronously.
 */
export const THEME_STORAGE_KEY = "ohb:theme"

/** Set on <html> so the head script knows whether it must consult the OS. */
export const THEME_MODE_ATTR = "data-theme-mode"
export const THEME_ACCENT_ATTR = "data-accent"

export const MEDIA_DARK = "(prefers-color-scheme: dark)"

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (THEME_MODES as readonly string[]).includes(value)
}

export function isAccent(value: unknown): value is AccentId {
  return typeof value === "string" && (ACCENTS as readonly string[]).includes(value)
}

/** Coerce any input to a valid mode, falling back to the default. */
export function normalizeMode(value: unknown): ThemeMode {
  return isThemeMode(value) ? value : DEFAULT_MODE
}

/** Coerce any input to a valid accent, falling back to the default. */
export function normalizeAccent(value: unknown): AccentId {
  return isAccent(value) ? value : DEFAULT_ACCENT
}

/** Coerce a partial `{ mode, accent }` payload to a complete theme. */
export function normalizeTheme(value: unknown): Theme {
  const raw = (value ?? {}) as Partial<Record<keyof Theme, unknown>>
  return { mode: normalizeMode(raw.mode), accent: normalizeAccent(raw.accent) }
}
