import { RuntimeDirectActions, RuntimeDirectStatus } from "../../../components/runtime-direct";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconShieldExclamation } from "@tabler/icons-react";
import { cn, toast, useIsMobile } from "@openedbot/browser-ui-kit";
import { api, errorMessage, queryKeys } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import type { RuntimeLinkRotationDto, RuntimePublicDto } from "@openedbot/contracts-api";
import { InsetGroupedSection, InsetGroupedStatic } from "../../../components/mobile/inset-grouped";
import { SettingsPane } from "../pane";
import {
  ACTIONS,
  BUTTON,
  CardHeading,
  Note,
  SectionHeading,
  SettingsCard,
  StatusList,
  StatusRow,
  ToneBadge,
} from "../../../components/settings/primitives";
import { ProviderIncidentDialog } from "../../../components/provider-incident-banner";
import { RUNTIME_REFETCH_MS, runtimeRefetchMs, type RuntimeSection } from "./cloud/cloud-shared";
import { CopyableCommand } from "./cloud/cloud-token-help";
import { RuntimeFormSkeleton, RuntimeOwnershipHelp, RuntimeSectionRail } from "./cloud/cloud-runtime-chrome";
import { RuntimeLinkHero } from "./cloud/cloud-link-hero";
import { hasAutoUpgrade } from "../../../lib/runtime/auto-upgrade";
import { ConnectorUpgradeNotice, HermesUpdateNotice, RetiredLinkNotice, RuntimeLinkCheck } from "./cloud/cloud-link-check";
import { ConnectorReleaseNotesButton } from "../../../components/connector-update-dialog";
import { linkHealthErrorText } from "../../../lib/runtime/link-health-error";
import { RuntimeRemoval, RuntimeReplacement } from "./cloud/cloud-registry";
import { RuntimeTerminalSwitch } from "./cloud/cloud-terminal-switch";
import { RuntimeAlertsSection } from "./cloud/cloud-alerts";
import { RuntimeVersionRows } from "./cloud/cloud-versions";

export { isRuntimeSection, type RuntimeSection } from "./cloud/cloud-shared";
export { HermesTokenHelpDialog } from "./cloud/cloud-token-help";
export { CloudSettingsOverview } from "./cloud/cloud-overview";
export { RuntimeReplacement } from "./cloud/cloud-registry";

export function CloudRuntimeSettings({
  section,
  onSectionChange,
}: {
  /** The open section, when the URL carries it. Otherwise the screen holds it itself. */
  section?: RuntimeSection;
  onSectionChange?: (section: RuntimeSection) => void;
}) {
  const configuration = useQuery({
    queryKey: queryKeys.runtimeConfiguration,
    queryFn: api.runtimeConfiguration,
    refetchInterval: (query) => runtimeRefetchMs(query.state.data),
  });
  if (configuration.isPending) return <SettingsPane><RuntimeFormSkeleton /></SettingsPane>;
  if (configuration.error || !configuration.data) {
    return (
      <RuntimeConnectionForm
        runtime={null}
        loadError="Impossible de lire la configuration du runtime. Les valeurs ci-dessous ne sont pas enregistrées."
        section={section}
        onSectionChange={onSectionChange}
      />
    );
  }
  return (
    <RuntimeConnectionForm
      key={configuration.data.runtime?.id ?? "new"}
      runtime={configuration.data.runtime}
      section={section}
      onSectionChange={onSectionChange}
    />
  );
}

function RuntimeConnectionForm({
  runtime,
  loadError,
  section,
  onSectionChange,
}: {
  runtime: RuntimePublicDto | null;
  loadError?: string;
  section?: RuntimeSection;
  onSectionChange?: (section: RuntimeSection) => void;
}) {
  const { t, formatDate } = useT();
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  // The new token exists only in this state, long enough to copy it: it is
  // neither cached by the request, nor rereadable after a reload.
  const [issuedLink, setIssuedLink] = useState<RuntimeLinkRotationDto | null>(null);
  // Suspected hijack: the open connection may be the hijacker's,
  // so an emergency rotation: no grace, no push, link cut.
  const hijackSuspectedAt = runtime?.reachability === "connector" ? runtime.link?.hijackSuspectedAt ?? null : null;
  const rotate = useMutation({
    mutationFn: () => {
      if (!runtime?.id) throw new Error("runtime");
      return api.rotateRuntimeLinkToken(runtime.id, "emergency");
    },
    onSuccess: async (issued) => {
      setIssuedLink(issued);
      await queryClient.invalidateQueries({ queryKey: queryKeys.runtime });
      await queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfiguration });
      toast.success(t("cloudRuntimeSettings.rotateLinkTokenSuccess"));
    },
    onError: (error) => toast.error(errorMessage(error, t("cloudRuntimeSettings.rotateLinkTokenFailed"))),
  });
  // A `connector` runtime has neither a URL nor a token on the cloud side, and PUT /api/runtime
  // refuses it (409 RUNTIME_REACHABILITY_IMMUTABLE): the screen therefore promises
  // no editing: only reading and the probe remain.
  const isConnectorRuntime = runtime?.reachability === "connector";
  // The displayed token survives neither a closed box nor a left screen.
  const dismissIssuedLink = (): void => {
    setIssuedLink(null);
    rotate.reset();
  };
  const resetRotation = rotate.reset;
  useEffect(() => () => {
    resetRotation();
  }, [resetRotation]);

  // The rail's counter: a replacement waiting, visible without opening the
  // section. Same key as the section, so a single request.
  const registry = useQuery({ queryKey: queryKeys.runtimeList, queryFn: api.runtimeList, refetchInterval: RUNTIME_REFETCH_MS });
  const pendingCount = registry.data?.filter((entry) => !entry.isActive).length ?? 0;
  // With no runtime declared, « État » has nothing to tell: we do not offer a
  // tab that would lead only to emptiness.
  const sections: { id: RuntimeSection; label: string; count?: number }[] = [
    ...(runtime ? [{ id: "status" as const, label: "État" }] : []),
    // The alerts say a runtime is down: with no runtime, nothing to watch.
    ...(runtime ? [{ id: "alerts" as const, label: t("runtimeAlerts.tab") }] : []),
    {
      id: "runtimes",
      label: t(runtime ? "cloudRuntimeSettings.replaceAction" : "cloudRuntimeSettings.addAction"),
      ...(pendingCount > 0 ? { count: pendingCount } : {}),
    },
  ];
  // With no runtime, one lands on the add: it is the only thing to do.
  const fallbackSection: RuntimeSection = !runtime ? "runtimes" : "status";
  const [localSection, setLocalSection] = useState<RuntimeSection | null>(null);
  const requested = section ?? localSection;
  const currentSection = requested && sections.some((entry) => entry.id === requested) ? requested : fallbackSection;
  const goTo = (next: RuntimeSection): void => {
    setLocalSection(next);
    onSectionChange?.(next);
  };

  // Rotation is no longer a routine maintenance action: on a healthy
  // link, the token is entirely managed by the pairing workflow. It is
  // exposed only as an explicit answer to a suspected hijack.
  const rotateButton = isConnectorRuntime && hijackSuspectedAt ? (
    <button
      type="button"
      className={cn(BUTTON.primary, "min-h-11")}
      disabled={!runtime?.id || rotate.isPending}
      onClick={() => rotate.mutate()}
    >
      {t("cloudRuntimeSettings.rotateLinkTokenEmergency")}
    </button>
  ) : null;
  // Removal sits next to « Tester »: it is the card that describes THIS
  // runtime, so the place where one looks for it. The Remplacer section offers
  // a second one, on the waiting replacement's card.
  const actions = runtime ? (
    <>
      {runtime.reachability === "direct" ? <RuntimeDirectActions runtime={runtime} /> : null}
      {rotateButton}
      <RuntimeRemoval runtime={runtime} />
    </>
  ) : null;
  // Banner « lien remplacé depuis une autre adresse »: Inset Grouped, one
  // sentence, never truncated; the answering gesture is the rotation button.
  const hijackBanner = hijackSuspectedAt ? (
    <InsetGroupedSection className="bg-card px-0 pt-0">
      <InsetGroupedStatic
        icon={IconShieldExclamation}
        label={t("cloudRuntimeSettings.linkHijackTitle")}
        value={t("cloudRuntimeSettings.linkHijackBanner", { date: formatDate(hijackSuspectedAt) })}
        multiline
      />
      <InsetGroupedStatic value={t("cloudRuntimeSettings.rotateLinkTokenEmergencyHint")} label="" multiline />
    </InsetGroupedSection>
  ) : null;
  // The new token, a single time, copyable, then never again.
  const issuedLinkBox = issuedLink ? (
    <div role="status" className="space-y-2 rounded-xl border border-border bg-surface-sunken/40 p-4">
      <CopyableCommand label={t("cloudRuntimeSettings.rotatedLinkTokenLabel")} value={issuedLink.linkToken} />
      <p className="text-xs text-muted-foreground">
        {issuedLink.mode === "emergency"
          ? t("cloudRuntimeSettings.rotatedLinkTokenEmergencyOnce")
          : t("cloudRuntimeSettings.rotatedLinkTokenOnce", {
              // With no readable expiry date, the sentence stays true without
              // promising a deadline the API has not published.
              date: issuedLink.expiresPreviousAt ? formatDate(issuedLink.expiresPreviousAt) : "son expiration",
            })}
      </p>
      <div className={ACTIONS}>
        <button type="button" className={BUTTON.secondary} onClick={dismissIssuedLink}>
          {t("cloudRuntimeSettings.dismissRotatedLinkToken")}
        </button>
      </div>
    </div>
  ) : null;
  // Section « État »: the facts behind the thread. The hero says whether the link is
  // open; here, what else openedbot knows about it, and who the machine belongs to.
  const retired = runtime?.link?.originRetired === true && Boolean(runtime.link.origin);
  const healthError = linkHealthErrorText(
    runtime?.lastHealthError,
    runtime?.link?.lastSeenAt,
    (seen) => t("cloudRuntimeSettings.linkClosedAfterRestart", { date: formatDate(seen) }),
  );
  const statusSection = (
    <>
      {runtime?.reachability === "direct" ? <RuntimeDirectStatus runtime={runtime} /> : null}
      {isConnectorRuntime && runtime ? (
        // Desktop: the facts sit flat in the card (no bordered list inside
        // it), the notices and the check under a hairline.
        <SettingsCard padded={isMobile} className={isMobile ? "space-y-4" : undefined}>
          <CardHeading
            title="Lien connecteur"
            description="Ce qu’openedbot sait de la connexion sortante de cet hôte."
          />
          <StatusList className={cn(!isMobile && "divide-border/60")}>
            {/* Right column in pills: each fact carries its tone, so
                the link's state is read by colour before it is read by word. */}
            <StatusRow label="Joignabilité" value={<ToneBadge tone="info">Connexion sortante</ToneBadge>} />
            <StatusRow
              label="Lien ouvert"
              value={runtime.link?.connected ? (
                <ToneBadge tone="success">oui</ToneBadge>
              ) : (
                <ToneBadge tone="warning">non</ToneBadge>
              )}
            />
            <RuntimeVersionRows link={runtime.link} />
            {/* The last sign of life is already under the thread: here it truncated at 390 px. */}
            {runtime.link?.rotatedAt ? (
              <StatusRow
                label="Jeton de lien"
                value={(
                  <ToneBadge tone="neutral">
                    {t("cloudRuntimeSettings.linkRotatedAt", { date: formatDate(runtime.link.rotatedAt) })}
                  </ToneBadge>
                )}
              />
            ) : null}
            {runtime.lastCheckedAt ? (
              <StatusRow
                label="Dernier test"
                value={<ToneBadge tone="neutral">{formatDate(runtime.lastCheckedAt)}</ToneBadge>}
              />
            ) : null}
            {healthError ? (
              <StatusRow
                label="Dernière erreur"
                value={(
                  // A sentence, not a tag: the pill must be able to
                  // wrap, otherwise `whitespace-nowrap` crops it.
                  <ToneBadge tone="danger" className="items-start whitespace-normal px-2.5 py-1 text-left font-mono">
                    {healthError}
                  </ToneBadge>
                )}
              />
            ) : null}
          </StatusList>
          <div className={cn("space-y-4", !isMobile && "border-t border-border/60 p-4")}>
            {retired ? (
              <RetiredLinkNotice runtime={runtime} />
            ) : (
              <>
                <ConnectorUpgradeNotice
                  connector={runtime.link?.connector}
                  connected={runtime.link?.connected === true}
                  autoUpgrade={hasAutoUpgrade(runtime.linkFeatures)}
                />
                <HermesUpdateNotice link={runtime.link} />
              </>
            )}
            <RuntimeLinkCheck key={runtime.id} runtime={runtime} retiredOrigin={retired ? runtime.link?.origin ?? null : null} />
          </div>
        </SettingsCard>
      ) : null}
      {runtime?.id ? <RuntimeTerminalSwitch runtimeId={runtime.id} /> : null}
      <ProviderIncidentDialog incidents={runtime?.providerIncidents} />
    </>
  );

  return (
    <SettingsPane footer={isMobile && currentSection !== "runtimes" && actions ? actions : undefined}>
      <SectionHeading
        title={t("settingsSidebar.runtime")}
        description="Choisissez comment openedbot joint votre runtime : lien sortant ou accès direct à votre charge."
        action={runtime ? (
          <div className="flex items-center gap-2">
            {runtime.link?.connector ? <ConnectorReleaseNotesButton /> : null}
            <RuntimeOwnershipHelp runtime={runtime} />
          </div>
        ) : undefined}
      />
      {loadError ? <Note tone="danger" role="alert">{loadError}</Note> : null}
      <RuntimeLinkHero
        runtime={runtime}
        actions={actions}
      >
        {hijackBanner}
        {issuedLinkBox}
      </RuntimeLinkHero>
      <RuntimeSectionRail sections={sections} current={currentSection} onChange={goTo}>
        {currentSection === "status" ? statusSection : null}
        {currentSection === "alerts" ? <RuntimeAlertsSection /> : null}
        {currentSection === "runtimes" ? <RuntimeReplacement activeId={runtime?.id ?? null} /> : null}
      </RuntimeSectionRail>
    </SettingsPane>
  );
}
