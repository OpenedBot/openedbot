import * as React from "react";
import { DEFAULT_LOCALE, FALLBACK_LOCALE, type Locale } from "@openedbot/contracts-locale";
import type { MessageKey, MessagePaths, MessageTree } from "@openedbot/contracts-i18n";
import { activateLocale, isLocaleLoaded, loadLocale, registerMessages, t } from "./dictionary";
import { formatDate as formatDateI18n, formatNumber as formatNumberI18n, plural as pluralI18n } from "./format";
import { LOCALE_STORAGE_KEY, readInitialLocale, writeStoredLocale } from "./locale-detect";

/**
 * Provider i18n de la console et du backoffice. La règle de choix de la langue
 * est celle de `locale-detect.ts`.
 */
export { LOCALE_STORAGE_KEY };

type I18nContextValue = {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
  formatDate: (
    value: string | number | Date | null | undefined,
    options?: Intl.DateTimeFormatOptions,
  ) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  plural: (count: number, forms: { one: string; other: string }) => string;
};

const I18nContext = React.createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = React.useState<Locale>(() =>
    typeof window === "undefined" ? DEFAULT_LOCALE : readInitialLocale(),
  );
  const [ready, setReady] = React.useState(() => isLocaleLoaded(locale));
  const switchRequest = React.useRef(0);

  React.useEffect(() => {
    let current = true;
    void loadLocale(locale).then(() => {
      if (!current) return;
      activateLocale(locale);
      setReady(true);
    }).catch(() => {
      // No dictionary at all: render the keys rather than a blank page.
      if (current) setReady(true);
    });
    return () => {
      current = false;
    };
  }, [locale]);

  const setLocale = React.useCallback((next: Locale) => {
    const request = ++switchRequest.current;
    if (next === locale) return;
    void loadLocale(next).then(() => {
      if (request !== switchRequest.current) return;
      activateLocale(next);
      writeStoredLocale(next);
      setLocaleState(next);
    }).catch(() => {
      // Keep the currently displayed locale if its replacement chunk fails.
    });
  }, [locale]);

  // `lang` suit la langue affichée : lecteur d'écran, césure et correcteur.
  React.useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = React.useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      t: (key, params) => t(locale, key, params),
      formatDate: (value, options) => formatDateI18n(locale, value, options),
      formatNumber: (value, options) => formatNumberI18n(locale, value, options),
      plural: (count, forms) => pluralI18n(locale, count, forms),
    }),
    [locale, setLocale],
  );

  // `t()` falls back to the loaded dictionary: render as soon as one is there.
  return ready || isLocaleLoaded(FALLBACK_LOCALE) ? <I18nContext.Provider value={value}>{children}</I18nContext.Provider> : null;
}

/** Traduction + langue active. `t` masque la locale : jamais à répéter à l'appel. */
export function useT(): I18nContextValue {
  const ctx = React.useContext(I18nContext);
  if (!ctx) throw new Error("useT must be used within an I18nProvider");
  return ctx;
}

/**
 * `useT` for the error path only. A failure screen shows precisely when the
 * tree above it is broken (a 502 storm, a provider that threw, a hot-reloaded
 * module holding a second context), so it must not depend on `I18nProvider`
 * being mounted: without one it reads the loaded dictionary directly in the
 * stored/browser language, as `main.tsx` does before the first render.
 */
export function useFallbackT(): Pick<I18nContextValue, "locale" | "t"> {
  const ctx = React.useContext(I18nContext);
  return React.useMemo(() => {
    if (ctx) return { locale: ctx.locale, t: ctx.t };
    const locale = typeof window === "undefined" ? DEFAULT_LOCALE : readInitialLocale();
    return { locale, t: (key, params) => t(locale, key, params) };
  }, [ctx]);
}

/**
 * A console module's own strings (open-core step 10): registers them, fr and
 * en, when the module loads, and returns its `useT`, whose `t` takes the
 * core keys and the module's. Its strings stay in the module's chunk, so a
 * build without the module carries none of them.
 */
export function defineMessages<T extends MessageTree>(messages: Record<Locale, MessageTree> & { fr: T }) {
  for (const locale of Object.keys(messages) as Locale[]) registerMessages(locale, messages[locale]);
  type ScopedT = Omit<I18nContextValue, "t"> & { t: (key: MessageKey | MessagePaths<T>, params?: Record<string, string | number>) => string };
  return function useModuleT(): ScopedT {
    return useT() as unknown as ScopedT;
  };
}
