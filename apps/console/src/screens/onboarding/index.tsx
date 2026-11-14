import { useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { api, isApiUnavailable, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { hasCompletedOnboarding } from "../../lib/session/onboarding-gate";
import { OnboardingFlow } from "./onboarding-flow";

/**
 * The welcome screen: the two reads the flow needs in order to
 * render: the persistent state (answers, workspace name, exit) and the roster
 * (the bots already there, the handle already chosen), then the flow itself.
 *
 * The runtime register is read by the step that uses it: it is its
 * « en cours de lecture » state that decides its scan phase, and the
 * TanStack Query cache shares it anyway.
 *
 * A cloud API that does not answer is SAID, it is not guessed: rendering the
 * flow on absent data would make « aucun bot, aucune réponse »
 * out of a simple cloud API outage.
 */
export function OnboardingScreen() {
  const { t } = useT();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { review?: number };
  const onboarding = useQuery({ queryKey: queryKeys.onboarding, queryFn: api.onboarding });
  const needsOrganization = onboarding.data?.needsOrganization === true;
  const roster = useQuery({
    queryKey: queryKeys.roster,
    queryFn: api.roster,
    enabled: onboarding.isSuccess && !needsOrganization,
  });

  /**
   * Onboarding is PER PERSON (`users.onboarding_completed`, exposed as
   * `completed`): whoever has already finished theirs is sent back to `/`, even if
   * the workspace itself is not dated yet. The gate in `route-tree.tsx` only
   * protects the automatic entry: this guard protects the route
   * ITSELF (direct link, return from login). `?review=1` is the only
   * exception: the overview's voluntary gesture.
   */
  const alreadyOnboarded = hasCompletedOnboarding(onboarding.data) && !search.review && !needsOrganization;
  useEffect(() => {
    if (alreadyOnboarded) void navigate({ to: "/", replace: true });
  }, [alreadyOnboarded, navigate]);
  if (alreadyOnboarded) return null;

  if (isApiUnavailable(onboarding.error) || isApiUnavailable(roster.error)) {
    return (
      <OnboardingWindow>
        <OnboardingNotice>
          <p
            role="status"
            className="rounded-xl border border-warn-700/40 bg-warn-soft px-3 py-2 text-caption leading-5 text-warn-700"
          >
            {t("onboarding.cloudApiDownNote")}
          </p>
        </OnboardingNotice>
      </OnboardingWindow>
    );
  }

  if (onboarding.isPending || (!needsOrganization && roster.isPending)) {
    return (
      <OnboardingWindow>
        <OnboardingNotice>
          <div
            role="status"
            aria-label={t("onboarding.loadingInstall")}
            className="flex w-full flex-col gap-3"
          >
            <div className="h-4 w-40 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <div className="h-10 w-full animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
            <div className="h-10 w-full animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
          </div>
        </OnboardingNotice>
      </OnboardingWindow>
    );
  }

  // An error that is NOT « cloud API éteint », a 401 first, must
  // above all not fabricate a blank state: on a workspace already onboarded, that
  // fallback rendered the full flow to whoever arrived here during an
  // authentication error. It is said, it is not papered over.
  if (onboarding.error || (!needsOrganization && roster.error)) {
    return (
      <OnboardingWindow>
        <OnboardingNotice>
          <p
            role="alert"
            className="rounded-xl border border-warn-700/40 bg-warn-soft px-3 py-2 text-caption leading-5 text-warn-700"
          >
            {t("onboarding.loadFailedNote")}
          </p>
        </OnboardingNotice>
      </OnboardingWindow>
    );
  }

  const state = onboarding.data;
  if (!state) return null;

  return (
    <OnboardingWindow>
      <OnboardingFlow state={state} roster={roster.data} />
    </OnboardingWindow>
  );
}

/**
 * The flow's window, and the reason it exists.
 *
 * `rootRoute` renders its pages in `<Shell>`, whose `SidebarProvider` is a
 * `flex` container in a ROW (`h-svh overflow-hidden`). The roots carried from
 * Multica (`step-welcome.tsx`, `StepShell`) carry neither `w-full` nor
 * `flex-1`: at Multica they do not need them, the flow is mounted there
 * in a full-window container. Here, without this container, the welcome screen
 * shrank to the width of its content (~885 px) stuck to the left instead of
 * the two expected 50/50 columns.
 *
 * This frame is therefore the equivalent of their window container, and it is set
 * HERE rather than by adding classes to the carried roots: those
 * must stay word for word Multica's, otherwise the next
 * comparison with the reference is done on code that has already diverged.
 *
 * `overflow-hidden`: scrolling belongs to the step's body (the `main`
 * of `StepShell`), not to the window: the same rule as the application's
 * shell (`components/shell.tsx`).
 */
function OnboardingWindow({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-svh min-h-0 w-full flex-1 flex-col overflow-hidden bg-background">
      {children}
    </div>
  );
}

/** The frame of the pre-flow states: nothing to lay out, a single column. */
function OnboardingNotice({ children }: { children: ReactNode }) {
  return (
    <div className="scrollbar-subtle flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 py-10">
      <div className="flex w-full max-w-[28rem] flex-col gap-6">{children}</div>
    </div>
  );
}
