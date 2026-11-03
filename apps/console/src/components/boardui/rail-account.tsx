import type { ReactNode } from "react";
import { RiMoonLine, RiSunLine } from "@remixicon/react";
import { Tooltip, TooltipContent, TooltipTrigger, cn } from "@openedbot/browser-ui-kit";
import { useTheme } from "@openedbot/browser-ui-kit/theme";
import { LOCALES } from "@openedbot/contracts-locale";
import { useT } from "../../lib/i18n";

/**
 * Le compte, à plat dans le rail (variante C, console et desktop) : plus de
 * menu à ouvrir. Le popover du compte coûtait un clic et une attente à chaque
 * geste (décision opérateur du 02-11-2026) ; chaque action y est désormais un
 * bouton du rail : thème, langue. La déconnexion est en bas des Réglages. Le compte s'ouvre par
 * les Réglages (« Mon compte »), sans avatar dans le rail. La version passe
 * dans l'infobulle du logo (`BoardIconRail`).
 */

function RailTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

/** Un clic bascule le thème ; l'icône montre celui vers lequel on va. */
export function RailThemeToggle({ buttonClassName }: { buttonClassName: string }) {
  const { t } = useT();
  const theme = useTheme();
  const dark = theme.resolved === "dark";
  const label = t(dark ? "navUser.lightTheme" : "navUser.darkTheme");
  return (
    <RailTip label={label}>
      <button type="button" aria-label={label} className={buttonClassName} onClick={() => theme.setMode(dark ? "light" : "dark")}>
        {dark ? <RiSunLine aria-hidden /> : <RiMoonLine aria-hidden />}
      </button>
    </RailTip>
  );
}

/** Un clic passe à la langue suivante ; le bouton affiche la langue courante. */
export function RailLanguageToggle({ buttonClassName }: { buttonClassName: string }) {
  const { t, locale, setLocale } = useT();
  const next = LOCALES[(LOCALES.indexOf(locale) + 1) % LOCALES.length] ?? locale;
  const label = t("navUser.switchLanguage", {
    language: t(next === "fr" ? "settings.appearance.languageFr" : "settings.appearance.languageEn"),
  });
  return (
    <RailTip label={label}>
      <button type="button" aria-label={label} lang={next} className={buttonClassName} onClick={() => setLocale(next)}>
        <span aria-hidden className="text-[11px] leading-none font-semibold tracking-wide uppercase">{locale}</span>
      </button>
    </RailTip>
  );
}
