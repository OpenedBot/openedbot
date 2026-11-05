import { Component, type ReactNode } from "react";
import { useFallbackT } from "../lib/i18n";
import { APP_HOME_HREF } from "../lib/workspace/workspace-location";
import { FailureState } from "./failure-state";
import { BUTTON } from "./settings/primitives";

/**
 * L'écran d'un plantage : l'équivalent d'`error.tsx` / `global-error.tsx`.
 *
 * Sans lui, une exception de rendu laisse une page BLANCHE : le routeur démonte
 * l'arbre et rien ne dit ce qui s'est passé, ni comment repartir. C'est le pire
 * des états, parce qu'il est indiscernable d'un chargement qui n'aboutit pas.
 *
 * Deux emplois, la même page (`FailureState`, placement `page`) :
 *   - `defaultErrorComponent` du routeur, pour ce qui casse DANS un écran ;
 *   - `AppErrorBoundary`, posé à la racine, pour ce qui casse autour de lui
 *     (un provider, le shell, la palette) que le routeur n'attrape pas.
 *
 * L'erreur est écrite dans la console avant d'être rendue : en développement
 * c'est là que se trouve la pile, et l'écran n'a pas vocation à l'afficher.
 *
 * Elle ne dépend pas d'`I18nProvider` (`useFallbackT`) : l'écran d'un plantage
 * doit s'afficher même quand le contexte au-dessus de lui est absent (une
 * frontière montée hors provider, un module rechargé à chaud, un test). Hors
 * provider il lit le dictionnaire chargé dans la langue du navigateur.
 *
 * `fullPage` : plus de coque autour (la frontière racine). La page remplit
 * le viewport ; dans un outlet, `min-h-full` suffit à remplir le panneau.
 */
export function AppErrorScreen({
  error,
  reset,
  fullPage = false,
}: {
  error: unknown;
  reset?: () => void;
  fullPage?: boolean;
}) {
  const { t } = useFallbackT();
  return (
    <div className={fullPage ? "flex min-h-dvh w-full flex-col" : "flex min-h-full w-full flex-col"}>
      <FailureState
        error={error}
        fallback={t("errorState.unexpected")}
        placement="page"
        art={
          // Decorative: the title says what happened. A static file, no
          // import: this screen shows when the bundle itself may be failing.
          <img
            src="/errors/screen-stopped.webp"
            alt=""
            aria-hidden
            width={768}
            height={768}
            decoding="async"
            className="size-40 shrink-0 object-contain md:size-72 lg:size-80"
          />
        }
        action={
          <>
            <button
              type="button"
              className={BUTTON.primary}
              onClick={reset ?? (() => globalThis.location?.reload())}
            >
              {t("errorState.retry")}
            </button>
            {/* Une ancre, pas un `Link` : cet écran s'affiche justement quand le
                routeur ou l'arbre au-dessus de lui est en défaut. Une navigation
                côté client dépendrait de ce qui vient de casser, et ne
                réinitialiserait rien. */}
            <a className={BUTTON.secondary} href={APP_HOME_HREF}>
              {t("errorState.quit")}
            </a>
          </>
        }
      />
    </div>
  );
}

type BoundaryProps = { children: ReactNode };
type BoundaryState = { error: unknown };

/**
 * La frontière de dernier recours. React n'expose pas d'équivalent hook : une
 * classe est le seul moyen d'attraper une exception de rendu.
 */
export class AppErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error };
  }

  override componentDidCatch(error: unknown, info: unknown) {
    // La pile complète va dans la console, jamais à l'écran : elle nomme nos
    // fichiers et nos composants, ce qui n'aide pas celui qui lit la page.
    console.error("[openedbot] rendu interrompu", error, info);
  }

  override render() {
    if (this.state.error === null) return this.props.children;
    return (
      <AppErrorScreen error={this.state.error} reset={() => this.setState({ error: null })} fullPage />
    );
  }
}
