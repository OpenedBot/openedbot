import type { CSSProperties, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { IconLock, IconMoon, IconSun } from "@tabler/icons-react";
import type { LegalSlug } from "@openedbot/contracts-api";
import { useTheme } from "@openedbot/browser-ui-kit/theme";
import { useT } from "../../lib/i18n";
import { publicSiteUrl } from "../../lib/session/public-site";

const LEGAL_LABELS: Record<LegalSlug, "legal.mentions" | "legal.privacy" | "legal.terms"> = {
  mentions: "legal.mentions",
  privacy: "legal.privacy",
  terms: "legal.terms",
};

/**
 * The brand, at the top of the screen: the icon and the name. It leads back to the public
 * site when the build has one (`VITE_PUBLIC_SITE_URL`), otherwise to `/` (which the
 * guard sends back here with no session). In the shell, there is nowhere to go.
 */
export function SigninBrand({ linked }: { linked: boolean }) {
  const content = (
    <>
      <span className="si-brand-mark">
        <img src="/brand/openedbot-icon.webp" alt="" aria-hidden="true" />
      </span>
      <span className="si-brand-name">openedbot</span>
    </>
  );
  const site = publicSiteUrl();
  if (!linked) return <div className="si-brand">{content}</div>;
  if (site) return <a href={`${site}/`} className="si-brand" aria-label="openedbot">{content}</a>;
  return <Link to="/" className="si-brand" aria-label="openedbot">{content}</Link>;
}

export function SigninNote({ tone, role, children }: { tone: "warning" | "danger" | "neutral"; role?: "alert" | "status"; children: ReactNode }) {
  return (
    <div className="si-note" data-tone={tone} role={role}>
      {children}
    </div>
  );
}

/** A 3×3 matrix of dots that light up in turn, for the length of a wait. */
export function MatrixSpinner() {
  return (
    <span className="si-matrix" aria-hidden="true">
      {Array.from({ length: 9 }, (_, index) => (
        <span key={index} style={{ "--k": index } as CSSProperties} />
      ))}
    </span>
  );
}

/** The promise made under the form, with its lock. */
export function SigninReassurance() {
  const { t } = useT();
  return (
    <p className="si-reassurance">
      <IconLock aria-hidden="true" />
      <span>{t("login.ledgerFootnote")}</span>
    </p>
  );
}

/** The legal pages the deployment actually SERVES, the language and the theme. */
export function SigninFooter({ legal }: { legal: LegalSlug[] }) {
  const { locale, setLocale, t } = useT();
  const theme = useTheme();
  const dark = theme.resolved === "dark";
  return (
    <footer className="si-footer">
      {legal.length > 0 ? (
        <nav className="si-legal" aria-label={t("legal.navigationLabel")}>
          {legal.map((slug) => (
            <Link key={slug} to="/legal/$slug" params={{ slug }}>{t(LEGAL_LABELS[slug])}</Link>
          ))}
        </nav>
      ) : <span />}
      <div className="si-footer-controls">
        <fieldset className="si-locale">
          <legend className="si-sr-only">{t("settings.appearance.languageTitle")}</legend>
          {(["fr", "en"] as const).map((candidate) => (
            <button key={candidate} type="button" aria-pressed={locale === candidate} onClick={() => setLocale(candidate)}>
              {candidate}
            </button>
          ))}
        </fieldset>
        <button
          type="button"
          role="switch"
          aria-checked={dark}
          aria-label={t(dark ? "settings.appearance.themeLight" : "settings.appearance.themeDark")}
          onClick={() => theme.setMode(dark ? "light" : "dark")}
          className="si-theme"
        >
          {dark ? <IconMoon aria-hidden="true" /> : <IconSun aria-hidden="true" />}
        </button>
      </div>
    </footer>
  );
}
