import { useEffect, useRef } from "react";
import { lazyRouteComponent, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useIsMobile } from "@openedbot/browser-ui-kit";
import { SiteHeader } from "../../components/dashboard/site-header";
import { api, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { needsOnboarding } from "../../lib/session/onboarding-gate";
import { consumeMobileLanding, firstRosterBotId, isMobileLandingConsumed } from "../../lib/shell/mobile-landing";

const OverviewScreen = lazyRouteComponent(() => import("./overview"), "OverviewScreen");

/** The Salon header, the same as `OverviewScreen`'s, without the scene. */
export function IndexPending() {
  const { t } = useT();
  const isMobile = useIsMobile();
  return (
    <div className="openedbot-salon-shell relative flex min-h-0 flex-1 flex-col">
      <SiteHeader title={t("overviewPlaceholder.nav")} heading={isMobile} align="center" root />
    </div>
  );
}

export function IndexRoute() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const onboarding = useQuery({ queryKey: queryKeys.onboarding, queryFn: api.onboarding });
  // Neither while loading, nor on error: a read that did not succeed (cloud API not
  // ready yet) proves nothing, and redirecting on it would send the user to redo a
  // flow already done on every slow cloud API restart. `false`
  // STRICTLY is the cloud API saying "this field exists and this person
  // has not left yet"; `undefined`: a cloud API from before the flag: says nothing.
  const toOnboarding =
    !onboarding.isPending && !onboarding.error && needsOnboarding(onboarding.data);

  // SAME key as the panel: on a phone the drawer mounts the roster in the
  // same frame, arrival reads its cache and adds no request.
  const roster = useQuery({
    queryKey: queryKeys.roster,
    queryFn: api.roster,
    enabled: isMobile && !toOnboarding,
  });
  /**
   * A conversation app opens on a thread, not on a dashboard:
   * on ARRIVAL (the first `/` of the load), a non-empty registry selects
   * the first bot in the panel. Empty registry: or a failed read: and we
   * stay on the overview, which carries « Nouveau bot ».
   *
   * The latch is read once on mount: « Aperçu » in the operator menu
   * must stay reachable afterwards, and a switch during render would
   * change what this component returns.
   */
  const isArrival = useRef(!isMobileLandingConsumed()).current;
  const autoBotId = isMobile && isArrival && roster.isSuccess ? firstRosterBotId(roster.data.bots) : null;
  const awaitingArrival = isMobile && isArrival && !toOnboarding && (onboarding.isPending || roster.isPending);

  useEffect(() => {
    if (toOnboarding) {
      void navigate({ to: "/onboarding", replace: true });
      return;
    }
    if (!isMobile || !isArrival || awaitingArrival) return;
    // Decided once: a roster that fails at launch stays on
    // the overview, it does not arm a jump on the next success.
    if (!consumeMobileLanding()) return;
    if (autoBotId) void navigate({ to: "/bot/$botId", params: { botId: autoBotId }, search: {}, replace: true });
  }, [toOnboarding, isMobile, isArrival, awaitingArrival, autoBotId, navigate]);

  if (toOnboarding) return null;
  // Nothing rather than an overview that jumps: the scene is already under the
  // drawer header, and the redirect lands right after.
  if (awaitingArrival || autoBotId) return null;

  // The header lives in the screen: on a phone it carries the "+" that opens the
  // same « Nouveau bot » sheet as the scene, and it reads that scene's scroll.
  return (
    <div className="openedbot-salon-shell relative flex min-h-0 flex-1 flex-col">
      <OverviewScreen />
    </div>
  );
}
