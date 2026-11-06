import type { Plugin } from "vite";
// Relative, like `vite.config.ts` does: the config bundle leaves package
// specifiers external, and Node cannot load their TypeScript sources.
import { DEFAULT_LOCALE, LOCALES, type Locale } from "../../contracts/locale/src/index";

/** `LOCALE_STORAGE_KEY` of `@openedbot/browser-i18n`, which this config cannot import (see above); the test ties them. */
export const STORED_LOCALE_KEY = "openedbot:locale";

/**
 * Starts the active language's dictionary with the entry, not after it.
 *
 * `main.tsx` awaits `loadLocale` before its first render, and the dictionary
 * is a dynamic chunk: the browser only discovered it once the entry had run,
 * one more round trip on the critical path of every launch (ADR 0001, D1b).
 * A small inline script in `index.html` picks the language exactly as
 * `resolveInitialLocale` does (stored preference, then the browser's
 * languages, then the default) and adds a `modulepreload` for that chunk
 * alone. A wrong guess only costs a wasted download: `main.tsx` still loads
 * what it needs. `tests/lib/vite-locale-preload.test.ts` holds the two rules
 * together.
 */
export function localePreloadScript(files: Readonly<Record<Locale, string>>): string {
  return `(function () {
  var files = ${JSON.stringify(files)};
  var locales = ${JSON.stringify(LOCALES)};
  var locale = null;
  try {
    var stored = localStorage.getItem(${JSON.stringify(STORED_LOCALE_KEY)});
    if (locales.indexOf(stored) >= 0) locale = stored;
  } catch (e) {}
  if (!locale) {
    var languages = [];
    try { languages = Array.prototype.slice.call(navigator.languages || []).concat([navigator.language]); } catch (e) {}
    for (var i = 0; i < languages.length && !locale; i++) {
      var language = languages[i] ? String(languages[i]).toLowerCase().split("-")[0] : "";
      if (locales.indexOf(language) >= 0) locale = language;
    }
  }
  var link = document.createElement("link");
  link.rel = "modulepreload";
  link.crossOrigin = "";
  link.href = files[locale || ${JSON.stringify(DEFAULT_LOCALE)}];
  document.head.appendChild(link);
})();`;
}

const DICTIONARY_MODULE = /contracts[\\/]i18n[\\/]src[\\/]messages\.(fr|en)\.ts$/;

export function localePreload(): Plugin {
  let base = "/";
  return {
    name: "openedbot-locale-preload",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      // Post, and listed before the CSP plugin: its hash covers this script.
      order: "post",
      handler(html, context) {
        const files: Partial<Record<Locale, string>> = {};
        for (const output of Object.values(context.bundle ?? {})) {
          if (output.type !== "chunk") continue;
          // By the modules it carries: Rolldown leaves `facadeModuleId` empty
          // on these dynamic chunks.
          for (const id of Object.keys(output.modules)) {
            const locale = DICTIONARY_MODULE.exec(id)?.[1] as Locale | undefined;
            if (!locale) continue;
            if (files[locale] && files[locale] !== `${base}${output.fileName}`) throw new Error(`locale preload: ${locale} spans two chunks`);
            files[locale] = `${base}${output.fileName}`;
          }
        }
        const missing = LOCALES.filter((locale) => !files[locale]);
        // A dictionary folded into the entry has nothing to preload; one
        // missing chunk among two means the build changed shape: say so.
        if (missing.length === LOCALES.length) return html;
        if (missing.length > 0) throw new Error(`locale preload: no chunk for ${missing.join(", ")}`);
        return {
          html,
          tags: [{ tag: "script", children: localePreloadScript(files as Record<Locale, string>), injectTo: "head" }],
        };
      },
    },
  };
}
