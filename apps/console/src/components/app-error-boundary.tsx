import { Component, type ReactNode } from "react";
import { useFallbackT } from "../lib/i18n";
import { APP_HOME_HREF } from "../lib/workspace/workspace-location";
import { FailureState } from "./failure-state";
import { BUTTON } from "./settings/primitives";

/**
 * The crash screen: the equivalent of `error.tsx` / `global-error.tsx`.
 *
 * Without it, a render exception leaves a WHITE page: the router unmounts
 * the tree and nothing says what happened, nor how to start over. It is the worst
 * state, because it is indistinguishable from a load that never completes.
 *
 * Two uses, the same page (`FailureState`, placement `page`):
 *   - the router's `defaultErrorComponent`, for what breaks INSIDE a screen;
 *   - `AppErrorBoundary`, placed at the root, for what breaks around it
 *     (a provider, the shell, the palette) that the router does not catch.
 *
 * The error is written to the console before it is rendered: in development
 * that is where the stack is, and the screen is not meant to display it.
 *
 * It does not depend on `I18nProvider` (`useFallbackT`): a crash screen
 * must show even when the context above it is absent (a
 * boundary mounted outside the provider, a hot-reloaded module, a test). Outside
 * the provider it reads the dictionary loaded in the browser's language.
 *
 * `fullPage`: no shell left around it (the root boundary). The page fills
 * the viewport; in an outlet, `min-h-full` is enough to fill the panel.
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
            src="/errors/screen-stopped-cat-20261108.webp"
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
            {/* An anchor, not a `Link`: this screen shows precisely when the
                router or the tree above it has failed. Client-side
                navigation would depend on what just broke, and would
                reset nothing. */}
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
 * The last-resort boundary. React exposes no hook equivalent: a
 * class is the only way to catch a render exception.
 */
export class AppErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error };
  }

  override componentDidCatch(error: unknown, info: unknown) {
    // The full stack goes to the console, never onto the screen: it names our
    // files and our components, which does not help the person reading the page.
    console.error("[openedbot] rendu interrompu", error, info);
  }

  override render() {
    if (this.state.error === null) return this.props.children;
    return (
      <AppErrorScreen error={this.state.error} reset={() => this.setState({ error: null })} fullPage />
    );
  }
}
