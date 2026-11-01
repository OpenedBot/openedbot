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
import { McpPanel } from "./connectors-mcp";
import { ConnectorsDesktop } from "./connectors-desktop";
import { InventoryAlerts, SkillDialog, ToolsetDialog, groupSkills, toolsetStatusMap } from "./connectors-parts";
import { SettingsPane } from "../pane";
import {
  BUTTON,
  CardSkeleton,
  EmptyState,
  Note,
  SectionHeading,
  type Tone,
} from "../../../components/settings/primitives";

type CatalogSegment = "mcp" | "runtime" | "skills";

/**
 * Catalogue réel du runtime, et son administration quand l'hôte l'expose.
 *
 * Hermes 0.20.x publie l'inventaire par `/v1/toolsets` et `/v1/skills`. Sa
 * gateway ne publie AUCUNE écriture : les routes MCP appartiennent au
 * Dashboard Hermes, derrière une session utilisateur interactive qui n'est ni
 * le bearer du runtime, ni un credential de service à privilège minimal.
 *
 * L'écriture ne passe donc pas par la gateway mais par l'opérateur
 * `edge-setup` de l'HÔTE, sur le même canal HTTPS déjà authentifié que les
 * runs, et seulement s'il l'annonce (`management.capabilities`). Le geste se
 * limite à des verbes nommés : activer un toolset, ajouter ou retirer un
 * serveur MCP, installer une entrée du catalogue approuvé : aucune commande,
 * aucun chemin de fichier, aucun secret ne revient au navigateur.
 *
 * Un hôte qui n'annonce rien retrouve exactement la page d'avant : l'état
 * observé, les commandes à jouer à la console, et pas un bouton qui mentirait.
 *
 * Desktop = rubriques Connecteurs | Compétences | Outils en lignes sur deux
 * colonnes (`connectors-desktop.tsx`), l'administration de l'hôte derrière
 * « Catalogue de l'hôte ». PWA = segments
 * Serveurs MCP | Toolsets | Skills, inset grouped, CTA dans le footer. Les
 * serveurs MCP viennent de leur inventaire dédié, jamais d'une heuristique sur
 * le nom d'un toolset.
 *
 * Tout cela dépend d'un fait unique : un runtime est déclaré, ou non. Sans
 * runtime il n'y a pas d'inventaire à lire : l'écran se referme sur une card
 * centrée, et le seul geste est de déclarer un Edge. Même verdict que Modèles
 * (`models-readiness.ts`, état `missing`) et Importer des agents.
 */
export function ConnectorsSettings() {
  const { t } = useT();
  const isMobile = useIsMobile();
  // `/api/runtime` est la source que lisent déjà Modèles et Edge.
  // L'inventaire porte le même fait (`runtime`).
  const configuration = useQuery({
    queryKey: queryKeys.runtimeConfiguration,
    queryFn: api.runtimeConfiguration,
  });
  const queryClient = useQueryClient();
  const inventory = useQuery({
    queryKey: queryKeys.runtimeIntegrations,
    queryFn: () => api.runtimeIntegrations(),
  });
  // « Actualiser » relisait la même route sans `fresh` : l'API rendait son
  // instantané en quelques millisecondes, la date d'observation ne bougeait
  // pas et une erreur de l'hôte (skills) restait affichée pour toujours. La
  // relecture saute le cache serveur et remplace ce que la page montre.
  const refresh = useMutation({
    mutationFn: () => api.runtimeIntegrations(true),
    onSuccess: (fresh) => queryClient.setQueryData(queryKeys.runtimeIntegrations, fresh),
    onError: (error) => toast.error(errorMessage(error, t("connectorsSettings.refreshFailed"))),
  });
  const refreshing = refresh.isPending || inventory.isFetching;
  // Les deux routes lisent le MÊME enregistrement : qu'une seule ait vu un
  // runtime suffit à ne pas affirmer le contraire.
  //
  // `isSuccess` porte tout le poids : sans lui, `data?.runtime ?? null`
  // confondait « la route a répondu, il n'y a pas de runtime » avec « la
  // requête est tombée » (`data` vaut `undefined` dans les deux cas). Une API
  // injoignable grisait donc la page et disait « connectez un runtime » à un
  // A failed read used to gray out the page for an operator who had a runtime,
  // which also removed the retry action. A failed read proves nothing.
  const sawRuntime =
    (configuration.isSuccess && configuration.data.runtime !== null)
    || (inventory.isSuccess && inventory.data.runtime !== null);
  const observedNoRuntime =
    (configuration.isSuccess && configuration.data.runtime === null)
    || (inventory.isSuccess && inventory.data.runtime === null);
  const blocked = observedNoRuntime && !sawRuntime;
  // Le libellé ne change pas pendant la relecture : « Actualisation… » est
  // plus long, le bouton s'élargissait puis se rétractait, et tout l'en-tête
  // sautait deux fois. L'icône tourne à la place, et `aria-busy` le dit.
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
        // Une erreur de lecture reste affichée telle quelle : l'état de la
        // page vient de la requête, la relecture n'en efface que le contenu.
        if (inventory.isError) void inventory.refetch();
        else refresh.mutate();
        // Le runtime a pu naître ailleurs entre-temps : relire l'inventaire
        // sans relire `/api/runtime` laissait la page grisée pour toujours.
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
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              {[0, 1, 2].map((item) => <CardSkeleton key={item} label={t("common.loading")} rows={2} />)}
            </div>
          </>
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
        {/* Sans le code, le statut et la référence, cette phrase est la même
            que l'API soit éteinte, qu'elle ait rendu 500, ou que Hermes ait
            refusé le token : l'opérateur ne peut ni agir, ni transmettre. */}
        <FailureState
          error={inventory.error}
          fallback={t("connectorsSettings.loadError")}
          /* Le lien de réparation vit DANS le panneau, à côté de la panne
             qu'il répare. Posé seul dans la colonne de `SettingsPane`, il
             s'étirait sur toute la largeur : la colonne est un flex, et
             `BUTTON.secondary` n'a pas de largeur propre. */
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
          /* Pas de `px-4` ici : les groupes du panneau portent déjà l'inset
             (`[data-mobile-settings] [data-inset-grouped]`), et l'ajouter
             dehors décalait les cartes MCP de 36 px quand tout le reste de
             l'écran est à 20. */
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

        <p className="px-8 pt-4 pb-2 text-[13px] leading-4 text-[var(--ohb-grouped-caption)]">
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
