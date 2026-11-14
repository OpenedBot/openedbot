import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { IconRefresh, IconServerBolt } from "@tabler/icons-react";
import { cn, toast, useIsMobile } from "@openedbot/browser-ui-kit";
import type {
  BotSkillDto,
  RuntimeIntegrationInventoryDto,
  RuntimeIntegrationToolsetDto,
} from "@openedbot/contracts-api";
import { api, errorMessage, queryKeys } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import {
  InsetGroupedRow,
  InsetGroupedSection,
  MobileSegmented,
  InsetGroupedStatic,
} from "../../../components/mobile/inset-grouped";
import { FailureState } from "../../../components/failure-state";
import { McpPanel } from "./connectors/connectors-mcp";
import { ConnectorsDesktop } from "./connectors/connectors-desktop";
import { ConnectorsDesktopSkeleton } from "./connectors/connectors-skeleton";
import { InventoryAlerts, SkillDialog, ToolsetDialog, groupSkills, toolsetStatusMap } from "./connectors/connectors-parts";
import { SettingsPane } from "../pane";
import {
  BUTTON,
  EmptyState,
  Note,
  SectionHeading,
  type Tone,
} from "../../../components/settings/primitives";

type CatalogSegment = "mcp" | "runtime" | "skills";

/**
 * The runtime's real catalog, and its administration when the host exposes it.
 *
 * Hermes 0.20.x publishes the inventory through `/v1/toolsets` and `/v1/skills`. Its
 * gateway publishes NO write: the MCP routes belong to the
 * Hermes Dashboard, behind an interactive user session that is neither
 * the runtime's bearer, nor a least-privilege service credential.
 *
 * The write therefore does not go through the gateway but through the host's
 * `edge-setup` operator, on the same already-authenticated HTTPS channel as the
 * runs, and only if it announces it (`management.capabilities`). The gesture is
 * limited to named verbs: activate a toolset, add or remove an
 * MCP server, install an entry of the approved catalog: no command,
 * no file path, no secret comes back to the browser.
 *
 * A host that announces nothing gets exactly the previous page back: the observed
 * state, the commands to run at the console, and not a button that would lie.
 *
 * Desktop = sections Connecteurs | Compétences | Outils in rows on two
 * columns (`connectors-desktop.tsx`), the host's administration behind
 * « Catalogue de l'hôte ». PWA = segments
 * Serveurs MCP | Toolsets | Skills, inset grouped, CTA in the footer. The
 * MCP servers come from their dedicated inventory, never from a heuristic on
 * a toolset's name.
 *
 * All of that depends on a single fact: a runtime is declared, or not. With no
 * runtime there is no inventory to read: the screen closes over a centered
 * card, and the only gesture is to declare an Edge. The same verdict as Models
 * (`models-readiness.ts`, state `missing`) and Import agents.
 */
export function ConnectorsSettings() {
  const { t } = useT();
  const isMobile = useIsMobile();
  // `/api/runtime` is the source Models and Edge already read.
  // The inventory carries the same fact (`runtime`).
  const configuration = useQuery({
    queryKey: queryKeys.runtimeConfiguration,
    queryFn: api.runtimeConfiguration,
  });
  const queryClient = useQueryClient();
  const inventory = useQuery({
    queryKey: queryKeys.runtimeIntegrations,
    queryFn: () => api.runtimeIntegrations(),
  });
  // « Actualiser » reread the same route without `fresh`: the API returned its
  // snapshot in a few milliseconds, the observation date did not move
  // and a host error (skills) stayed displayed forever. The
  // reread skips the server cache and replaces what the page shows.
  const refresh = useMutation({
    mutationFn: () => api.runtimeIntegrations(true),
    onSuccess: (fresh) => queryClient.setQueryData(queryKeys.runtimeIntegrations, fresh),
    onError: (error) => toast.error(errorMessage(error, t("connectorsSettings.refreshFailed"))),
  });
  const refreshing = refresh.isPending || inventory.isFetching;
  // The two routes read the SAME record: one of them having seen a
  // runtime is enough not to assert the contrary.
  //
  // `isSuccess` carries all the weight: without it, `data?.runtime ?? null`
  // confused « la route a répondu, il n'y a pas de runtime » with « la
  // requête est tombée » (`data` is `undefined` in both cases). An unreachable
  // API therefore greyed the page and said « connectez un runtime » to an
  // operator. A failed read used to gray out the page for an operator who had a runtime,
  // which also removed the retry action. A failed read proves nothing.
  const sawRuntime =
    (configuration.isSuccess && configuration.data.runtime !== null)
    || (inventory.isSuccess && inventory.data.runtime !== null);
  const observedNoRuntime =
    (configuration.isSuccess && configuration.data.runtime === null)
    || (inventory.isSuccess && inventory.data.runtime === null);
  const blocked = observedNoRuntime && !sawRuntime;
  // The label does not change during the reread: « Actualisation… » is
  // longer, the button widened then shrank, and the whole header
  // jumped twice. The icon spins instead, and `aria-busy` says so.
  const refreshLabel = inventory.isError && !refreshing
    ? t("connectorsSettings.retry")
    : t("connectorsSettings.refresh");
  const refreshButton = (
    <button
      type="button"
      className={cn(BUTTON.secondary, "gap-1.5")}
      disabled={refreshing}
      aria-busy={refreshing}
      onClick={() => {
        // A read error stays displayed as it is: the page's
        // state comes from the request, the reread clears only its content.
        if (inventory.isError) void inventory.refetch();
        else refresh.mutate();
        // The runtime may have been born elsewhere in the meantime: rereading the inventory
        // without rereading `/api/runtime` left the page greyed out forever.
        void configuration.refetch();
      }}
    >
      {isMobile && !refreshing ? null : (
        <IconRefresh aria-hidden className={cn("size-4", refreshing && "animate-spin motion-reduce:animate-none")} />
      )}
      {refreshLabel}
      {refreshing ? <span className="sr-only">{t("connectorsSettings.refreshing")}</span> : null}
    </button>
  );
  const configureRuntime = (
    <Link className={BUTTON.secondary} to="/settings/runtime">
      {t("connectorsSettings.configureRuntime")}
    </Link>
  );
  const configureRuntimePrimary = (
    <Link className={BUTTON.primary} to="/settings/runtime">
      {t("connectorsSettings.configureRuntime")}
    </Link>
  );

  if (configuration.data?.runtime?.reachability === "direct") {
    return <SettingsPane><SectionHeading title={t("connectorsSettings.title")} /><Note tone="info">{t("connectorsSettings.hostManagedNote")} <code>edge-setup toolsets</code> {t("connectorsSettings.hostManagedAnd")} <code>edge-setup mcp</code> {t("connectorsSettings.hostManagedFromConsole")}</Note></SettingsPane>;
  }
  if (configuration.isPending || inventory.isPending) {
    return (
      <SettingsPane>
        <SectionHeading
          title={t("connectorsSettings.title")}
          description={t("connectorsSettings.description")}
        />
        {isMobile ? (
          <InsetGroupedSection caption={t("connectorsSettings.stateTitle")}>
            <InsetGroupedStatic label={t("common.loading")} />
          </InsetGroupedSection>
        ) : (
<ConnectorsDesktopSkeleton label={t("common.loading")} />
        )}
      </SettingsPane>
    );
  }

  if (blocked) {
    return (
      <SettingsPane footer={isMobile ? configureRuntimePrimary : undefined}>
        <SectionHeading
          title={t("connectorsSettings.title")}
          description={t("connectorsSettings.description")}
        />
        <EmptyState
          icon={<IconServerBolt />}
          title={t("connectorsSettings.noRuntimeTitle")}
          description={t("connectorsSettings.noRuntimeDescription")}
          actions={isMobile ? undefined : configureRuntimePrimary}
        />
      </SettingsPane>
    );
  }

  if (inventory.isError || !inventory.data) {
    return (
      <SettingsPane footer={isMobile ? <>{refreshButton}{configureRuntime}</> : undefined}>
        <SectionHeading
          title={t("connectorsSettings.title")}
          description={t("connectorsSettings.description")}
          action={isMobile ? undefined : refreshButton}
        />
        {/* Without the code, the status and the reference, this sentence is the same
            whether the API is down, whether it returned 500, or whether Hermes
            refused the token: the operator can neither act, nor pass it on. */}
        <FailureState
          error={inventory.error}
          fallback={t("connectorsSettings.loadError")}
          /* The repair link lives INSIDE the panel, next to the outage
             it repairs. Set alone in `SettingsPane`'s column, it
             stretched to the full width: the column is a flex, and
             `BUTTON.secondary` has no width of its own. */
          action={isMobile ? undefined : configureRuntime}
        />
      </SettingsPane>
    );
  }

  if (isMobile) {
    return (
      <ConnectorsMobile
        data={inventory.data}
        refreshButton={refreshButton}
        configureRuntime={configureRuntime}
      />
    );
  }

  return (
    <ConnectorsDesktop
      data={inventory.data}
      refreshButton={refreshButton}
    />
  );
}

function ConnectorsMobile({
  data,
  refreshButton,
  configureRuntime,
}: {
  data: RuntimeIntegrationInventoryDto;
  refreshButton: ReactNode;
  configureRuntime: ReactNode;
}) {
  const { t, formatDate, formatNumber } = useT();
  const runtime = data.toolsets ?? [];
  const segments = catalogSegments(data);
  const [segment, setSegment] = useState<CatalogSegment>(() => initialSegment(data, runtime, segments));
  const active = segments.includes(segment) ? segment : segments[0];
  const management = managementState(data, t, formatNumber);
  const stats = summaryRows(data, t).filter((row): row is readonly [string, number] => row[1] !== null);

  return (
    <SettingsPane footer={<>{refreshButton}{configureRuntime}</>}>
      <div data-connectors-layout="pwa-segments">
        <SectionHeading
          title={t("connectorsSettings.title")}
          description={t("connectorsSettings.description")}
        />
        <InventoryAlerts data={data} />

        {stats.length > 0 || data.runtime ? (
          <InsetGroupedSection caption={t("connectorsSettings.stateTitle")}>
            {stats.map(([label, value]) => (
              <InsetGroupedStatic key={label} label={label} value={formatNumber(value)} />
            ))}
            <InsetGroupedStatic
              label={t("connectorsSettings.managementTitle")}
              value={management.label}
            />
          </InsetGroupedSection>
        ) : null}

        {segments.length > 1 ? (
          <div className="px-4 pt-4">
            <CatalogSegments
              value={active ?? "runtime"}
              onChange={setSegment}
              segments={segments}
              counts={{
                mcp: data.management.serverCount,
                runtime: data.toolsets === null ? null : runtime.length,
                skills: data.skills === null ? null : data.skills.length,
              }}
            />
          </div>
        ) : null}

        {active === "mcp" ? (
          /* No `px-4` here: the panel's groups already carry the inset
             (`[data-mobile-settings] [data-inset-grouped]`), and adding it
             outside offset the MCP cards by 36 px when all the rest of the
             screen is at 20. */
          <div id="connectors-catalog" role="tabpanel" className="pt-2">
            {data.management.capabilities.mcp ? <McpPanel /> : (
              <InsetGroupedSection caption={t("connectorsSettings.configureInHermesTitle")}>
                <MobileCommandRow label={t("connectorsSettings.commandInspectMcp")} value="hermes mcp list" />
                <MobileCommandRow label={t("connectorsSettings.commandMcp")} value="hermes mcp picker" />
              </InsetGroupedSection>
            )}
          </div>
        ) : null}
        {active === "runtime" ? (
          <MobileToolsetList
            title={t("connectorsSettings.runtimeTitle")}
            empty={t("connectorsSettings.runtimeEmpty")}
            toolsets={runtime}
            canManage={data.management.capabilities.toolsets}
          />
        ) : null}
        {active === "skills" ? <MobileSkillsList skills={data.skills ?? []} /> : null}

        {active === "runtime" && !data.management.capabilities.toolsets ? (
          <InsetGroupedSection caption={t("connectorsSettings.configureInHermesTitle")}>
            <MobileCommandRow
              label={t("connectorsSettings.commandTools")}
              value="hermes tools"
            />
          </InsetGroupedSection>
        ) : null}

        <p className="px-8 pt-4 pb-2 text-[13px] leading-4 text-[var(--openedbot-grouped-caption)]">
          {t("connectorsSettings.configuredSignalNote")}
          {" · "}
          {t("connectorsSettings.observedAt", {
            date: formatDate(data.observedAt, { dateStyle: "medium", timeStyle: "short" }),
          })}
        </p>
      </div>
    </SettingsPane>
  );
}

function catalogSegments(data: RuntimeIntegrationInventoryDto): CatalogSegment[] {
  const segments: CatalogSegment[] = [];
  if (data.runtime !== null) segments.push("mcp");
  if (data.toolsets !== null) segments.push("runtime");
  if (data.skills !== null) segments.push("skills");
  return segments;
}

function initialSegment(
  data: RuntimeIntegrationInventoryDto,
  runtime: RuntimeIntegrationToolsetDto[],
  segments: CatalogSegment[],
): CatalogSegment {
  if (segments.includes("mcp") && (data.management.serverCount ?? 0) > 0) return "mcp";
  if (segments.includes("runtime") && runtime.length > 0) return "runtime";
  if (segments.includes("skills") && (data.skills?.length ?? 0) > 0) return "skills";
  return segments[0] ?? "runtime";
}

/** The catalogue segments, named after the shared primitive for this screen. */
function CatalogSegments({
  value,
  onChange,
  segments,
  counts,
}: {
  value: CatalogSegment;
  onChange: (segment: CatalogSegment) => void;
  segments: CatalogSegment[];
  counts: Record<CatalogSegment, number | null>;
}) {
  const { t, formatNumber } = useT();
  const labels: Record<CatalogSegment, string> = {
    mcp: t("connectorsSettings.segmentMcp"),
    runtime: t("connectorsSettings.segmentRuntime"),
    skills: t("connectorsSettings.segmentSkills"),
  };
  return (
    <MobileSegmented
      value={value}
      onChange={onChange}
      label={t("connectorsSettings.catalogSegments")}
      controls="connectors-catalog"
      idPrefix="connectors-seg"
      segments={segments.map((segment) => ({
        id: segment,
        label: labels[segment],
        count: counts[segment] === null ? null : formatNumber(counts[segment]!),
      }))}
    />
  );
}

function MobileToolsetList({
  title,
  empty,
  toolsets,
  canManage,
}: {
  title: string;
  empty: string;
  toolsets: RuntimeIntegrationToolsetDto[];
  canManage: boolean;
}) {
  const { t } = useT();
  const [selected, setSelected] = useState<RuntimeIntegrationToolsetDto | null>(null);
  const status = toolsetStatusMap(t);
  return (
    <div id="connectors-catalog" role="tabpanel">
      <InsetGroupedSection caption={title}>
        {toolsets.length === 0 ? (
          <InsetGroupedStatic label={empty} />
        ) : (
          toolsets.map((toolset) => (
            <InsetGroupedRow
              key={toolset.name}
              label={toolset.label}
              subtitle={toolset.name}
              value={status[toolset.status].label}
              onClick={() => setSelected(toolset)}
            />
          ))
        )}
      </InsetGroupedSection>
      <ToolsetDialog toolset={selected} onClose={() => setSelected(null)} canManage={canManage} />
    </div>
  );
}

function MobileSkillsList({ skills }: { skills: BotSkillDto[] }) {
  const { t } = useT();
  const [selected, setSelected] = useState<BotSkillDto | null>(null);
  const groups = groupSkills(skills);
  return (
    <div id="connectors-catalog" role="tabpanel">
      {groups.length === 0 ? (
        <InsetGroupedSection caption={t("connectorsSettings.skillsTitle")}>
          <InsetGroupedStatic label={t("connectorsSettings.skillsEmpty")} />
        </InsetGroupedSection>
      ) : (
        groups.map(([category, entries]) => (
          <InsetGroupedSection
            key={category || "uncategorized"}
            caption={category || t("connectorsSettings.uncategorized")}
          >
            {entries.map((skill) => (
              <InsetGroupedRow
                key={skill.name}
                label={skill.name}
                subtitle={skill.description ?? undefined}
                onClick={() => setSelected(skill)}
              />
            ))}
          </InsetGroupedSection>
        ))
      )}
      <SkillDialog skill={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function MobileCommandRow({
  label,
  value,
  disabled = false,
}: {
  label: string;
  value: string;
  disabled?: boolean;
}) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  return (
    <InsetGroupedRow
      label={label}
      subtitle={value}
      value={copied ? t("connectorsSettings.commandCopied") : t("connectorsSettings.copyCommand")}
      chevron={false}
      disabled={disabled}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(value)
          .then(() => setCopied(true))
          .catch(() => setCopied(false));
      }}
    />
  );
}

function managementState(
  inventory: RuntimeIntegrationInventoryDto,
  t: ReturnType<typeof useT>["t"],
  formatNumber: ReturnType<typeof useT>["formatNumber"],
): { label: string; description: string; tone: Tone } {
  const states: Record<RuntimeIntegrationInventoryDto["management"]["status"], {
    label: string;
    description: string;
    tone: Tone;
  }> = {
    runtime_missing: {
      label: t("connectorsSettings.managementRuntimeMissing"),
      description: t("connectorsSettings.managementRuntimeMissingDescription"),
      tone: "neutral",
    },
    not_exposed: {
      label: t("connectorsSettings.managementNotExposed"),
      description: t("connectorsSettings.managementNotExposedDescription"),
      tone: "warning",
    },
    runtime_token_not_accepted: {
      label: t("connectorsSettings.managementSeparateAuth"),
      description: t("connectorsSettings.managementSeparateAuthDescription"),
      tone: "warning",
    },
    read_endpoint_available: {
      label: t("connectorsSettings.managementReadOnly"),
      description: t("connectorsSettings.managementReadOnlyDescription", {
        count: formatNumber(inventory.management.serverCount ?? 0),
      }),
      tone: "info",
    },
    unavailable: {
      label: t("connectorsSettings.managementUnavailable"),
      description: t("connectorsSettings.managementUnavailableDescription"),
      tone: "warning",
    },
  };
  // A capable host describes its own management channel. The probe for
  // `GET /api/mcp/servers` still reports accurately, but it no longer decides
  // what this page can do or warns against the management panel below.
  if (inventory.management.writable) {
    return {
      label: t("connectorsSettings.managementWritable"),
      description: t("connectorsSettings.managementWritableDescription"),
      tone: "success",
    };
  }
  return states[inventory.management.status];
}

function summaryRows(
  inventory: RuntimeIntegrationInventoryDto,
  t: ReturnType<typeof useT>["t"],
): ReadonlyArray<readonly [string, number | null]> {
  return [
    [t("connectorsSettings.summaryReady"), inventory.totals.ready],
    [t("connectorsSettings.summaryNeedsConfiguration"), inventory.totals.configurationRequired],
    [t("connectorsSettings.summaryTools"), inventory.totals.tools],
    [t("connectorsSettings.summarySkills"), inventory.totals.skills],
  ];
}
