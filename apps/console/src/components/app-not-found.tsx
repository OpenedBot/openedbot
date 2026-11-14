import { Link, useLocation, useRouter } from "@tanstack/react-router";
import { useT } from "../lib/i18n";

/**
 * The screen for a URL that leads nowhere: the twin of `AppErrorScreen`
 * for the case where the router does not FIND, instead of crashing.
 *
 * Without it, TanStack renders its own fallback: the two words « Not Found » at
 * the top left, in English, outside the shell, with no gesture to start over.
 * A stale link (a bookmark, a notification, a path rewritten since) left
 * the operator in a dead end there.
 *
 * It reuses the `/login` shell (`login.css`, imported globally by
 * `globals.css`): editorial column on the left, themed illustration on the
 * right. It is the right neighbourhood: like the front door, this screen lives OUTSIDE
 * the application shell (the router has no route to give it) and must
 * therefore carry its own background, its mark and its safe area.
 *
 * The requested path is written on the screen: it is the only thing that tells
 * a typo from an application link that has gone wrong, and the person who
 * reads the page is the only one who can tell them apart.
 *
 * `Link` and `router.history` rather than anchors: the opposite of the error
 * screen, and for the opposite reason: here the router is FINE, it is the
 * route that is missing. Client-side navigation keeps the session, the cache and
 * the shell; a reload would discard them without repairing anything.
 */
export function NotFoundScreen() {
  const { t } = useT();
  const router = useRouter();
  const { pathname } = useLocation();
  // A URL opened directly (pasted link, bookmark, notification) has no
  // previous entry: the « revenir » button would do nothing at all there, and
  // a gesture that does not respond is worse than no gesture.
  const canGoBack = router.history.canGoBack();
  return (
    <div className="lg">
      <div className="lg-shell">
        <section className="lg-main">
          <span className="lg-brand">
            <span className="lg-brand-mark">
              <img src="/brand/openedbot-icon.webp" alt="" aria-hidden="true" />
            </span>
            <span>openedbot</span>
          </span>
          <div className="lg-content">
            <div className="lg-copy">
              <p className="lg-eyebrow">404</p>
              <h1 className="lg-title">{t("notFound.title")}</h1>
              <p className="lg-lead">{t("notFound.description")}</p>
            </div>
            {/* `word-break`: a path carries identifiers that break
                on no space, and would overflow the column on a phone. */}
            <p className="lg-path">{pathname}</p>
            <div className="lg-actions lg-actions--inline">
              <Link to="/" className="lg-submit">
                {t("notFound.home")}
              </Link>
              {canGoBack ? (
                <button type="button" className="lg-secondary" onClick={() => router.history.back()}>
                  {t("notFound.back")}
                </button>
              ) : null}
            </div>
          </div>
          {/* The `/login` column splits into three (mark, content,
              footer): without this spacer, the content would rise instead of sitting
              centred, as on the front door. */}
          <span aria-hidden="true" />
        </section>
        <aside className="lg-panel" aria-hidden="true" />
      </div>
    </div>
  );
}
