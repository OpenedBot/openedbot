"use client"

import * as React from "react"

import {
  MEDIA_DARK,
  THEME_ACCENT_ATTR,
  THEME_MODE_ATTR,
  type AccentId,
  type ResolvedMode,
  type Theme,
  type ThemeMode,
} from "./config"
import { readStoredTheme, writeStoredTheme } from "./storage"

type ThemeContextValue = Theme & {
  /** `mode` with `system` already resolved against the OS preference. */
  resolved: ResolvedMode
  setMode: (next: ThemeMode) => void
  setAccent: (next: AccentId) => void
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null)

const REDUCE_MOTION = "(prefers-reduced-motion: reduce)"
const THEME_TRANSITION_MS = 340

function subscribeToSystem(onChange: () => void) {
  const query = window.matchMedia(MEDIA_DARK)
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

const getSystemDark = () => window.matchMedia(MEDIA_DARK).matches

/** Never called in a WebView-only shell, but `useSyncExternalStore` wants it. */
const getServerSystemDark = () => false

function resolveMode(mode: ThemeMode, systemDark: boolean): ResolvedMode {
  return mode === "system" ? (systemDark ? "dark" : "light") : mode
}

/** `--background` de chaque schéma (`styles/app.css`) : ce que la barre d'état Android affiche. */
const THEME_COLOR: Record<ResolvedMode, string> = { light: "#ffffff", dark: "#121212" }

function paintDocument(resolved: ResolvedMode, mode: ThemeMode, accent: AccentId) {
  const root = document.documentElement
  root.classList.toggle("dark", resolved === "dark")
  root.setAttribute(THEME_MODE_ATTR, mode)
  root.setAttribute(THEME_ACCENT_ATTR, accent)
  // Les deux balises `media` de `index.html` reçoivent la couleur résolue :
  // quel que soit le schéma de l'OS, celle qui s'applique dit la vérité.
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = THEME_COLOR[resolved]
  }
}

function prefersReducedMotion() {
  return window.matchMedia(REDUCE_MOTION).matches
}

/**
 * Soft theme flip: View Transitions API when available (Chrome/Edge/Safari 18+),
 * otherwise a short-lived `.theme-transitioning` class that eases color tokens.
 * Instant snap under `prefers-reduced-motion`.
 */
function withThemeTransition(paint: () => void) {
  if (prefersReducedMotion()) {
    paint()
    return
  }

  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => { finished: Promise<void> }
  }

  if (typeof doc.startViewTransition === "function") {
    doc.startViewTransition(paint)
    return
  }

  const root = document.documentElement
  root.classList.add("theme-transitioning")
  paint()
  window.setTimeout(() => root.classList.remove("theme-transitioning"), THEME_TRANSITION_MS)
}

/**
 * Theme state for the whole shell.
 *
 * The choice lives in `localStorage` and is read once, at mount, from the same
 * key the head script already consulted before the first paint, so the state
 * React starts from is the one already on `<html>`, and there is no flash.
 *
 * The document attributes are driven from an effect rather than from the
 * `<html>` JSX: the head script may have added `.dark` on its own, and React
 * would not know to remove it when a prop it never saw change goes stale.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setLocalTheme] = React.useState<Theme>(readStoredTheme)

  const systemDark = React.useSyncExternalStore(subscribeToSystem, getSystemDark, getServerSystemDark)
  const resolved: ResolvedMode = resolveMode(theme.mode, systemDark)

  // Keep <html> in sync for OS-driven `system` flips (no user click → no VT).
  React.useEffect(() => {
    paintDocument(resolved, theme.mode, theme.accent)
  }, [resolved, theme.mode, theme.accent])

  const apply = React.useCallback((next: Theme, { animate }: { animate: boolean }) => {
    // The class toggle already repaints: the appearance is fully driven by
    // `.dark` + `data-accent` on <html>, not by a re-render. So the state
    // update and the write are only there to survive the next launch.
    const nextResolved = resolveMode(next.mode, getSystemDark())
    const paint = () => {
      paintDocument(nextResolved, next.mode, next.accent)
      setLocalTheme(next)
    }
    if (animate) withThemeTransition(paint)
    else paint()
    writeStoredTheme(next)
  }, [])

  const value = React.useMemo<ThemeContextValue>(
    () => ({
      ...theme,
      resolved,
      // Mode flips the whole palette → animate. Accent is a local hue swap → snap.
      setMode: (next) => next !== theme.mode && apply({ ...theme, mode: next }, { animate: true }),
      setAccent: (next) => next !== theme.accent && apply({ ...theme, accent: next }, { animate: false }),
    }),
    [theme, resolved, apply]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext)
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider")
  return ctx
}
