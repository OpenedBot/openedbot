import { FleetClientAudit, useFleetAuditScope } from "../../../pro-console/slots";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DecisionDto } from "@openedbot/contracts-api";
import {
  Badge,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
  useIsMobile,
} from "@openedbot/browser-ui-kit";
import { useT } from "../../../lib/i18n";
import { api, queryKeys } from "../../../lib/api";
import { InsetGroupedSection, MobileSegmented } from "../../../components/mobile/inset-grouped";
import { BUTTON } from "../../../components/settings/primitives";
import { useSettingsModal } from "../../../lib/settings-modal-context";
import { SettingsPane } from "../pane";
import { DecisionTrace } from "./decision-trace";

type ChoiceFilter = "all" | "once" | "deny";
type OriginFilter = "all" | "human" | "policy";

const FILTER_LABEL_KEY: Record<ChoiceFilter, "decisions.filterAll" | "decisions.filterAllowed" | "decisions.filterDenied"> = {
  all: "decisions.filterAll",
  once: "decisions.filterAllowed",
  deny: "decisions.filterDenied",
};

const FILTERS: ChoiceFilter[] = ["all", "once", "deny"];
const ORIGIN_FILTER_LABEL_KEY: Record<OriginFilter, "decisions.filterOriginAll" | "decisions.filterOriginHuman" | "decisions.filterOriginPolicy"> = {
  all: "decisions.filterOriginAll",
  human: "decisions.filterOriginHuman",
  policy: "decisions.filterOriginPolicy",
};
const ORIGIN_FILTERS: OriginFilter[] = ["all", "human", "policy"];

/**
 * Le journal des décisions : ce qui a été autorisé ou refusé, et sur quoi.
 *
 * Lecture seule : les grants de la base refusent `UPDATE` et `DELETE` sur les
 * lignes humaines du journal. La rubrique vit dans les réglages, à côté des
 * politiques qu'elle consigne.
 */
export function DecisionsSettings() {
  const { t, formatDate } = useT();
  // Dans la modale, son en-tête porte déjà le titre : celui-ci reste aux lecteurs d'écran.
  const inModal = useSettingsModal() !== null;
  const isMobile = useIsMobile();
  // In an agency client frame the log becomes the first tab of the client audit.
  const fleetAudit = useFleetAuditScope() !== null;
  const [choice, setChoice] = useState<ChoiceFilter>("all");
  const [origin, setOrigin] = useState<OriginFilter>("all");
  const filters = {
    ...(choice === "all" ? {} : { choice }),
    ...(origin === "all" ? {} : { origin }),
  };
  const decisions = useQuery({
    queryKey: queryKeys.decisions(filters),
    queryFn: () => api.decisions(filters),
  });

  const rows = decisions.data?.decisions ?? [];
  const filtersBar = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap items-center gap-2" aria-label={t("decisions.choiceFilterLabel")}>
        {FILTERS.map((filter) => (
          <button
            key={filter}
            type="button"
            className={cn(choice === filter ? BUTTON.primary : BUTTON.secondary, "max-md:min-h-11")}
            onClick={() => setChoice(filter)}
          >
            {t(FILTER_LABEL_KEY[filter])}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2" aria-label={t("decisions.originFilterLabel")}>
        {ORIGIN_FILTERS.map((filter) => (
          <button
            key={filter}
            type="button"
            className={cn(origin === filter ? BUTTON.primary : BUTTON.secondary, "max-md:min-h-11")}
            onClick={() => setOrigin(filter)}
          >
            {t(ORIGIN_FILTER_LABEL_KEY[filter])}
          </button>
        ))}
      </div>
      {/* Un lien et non un bouton : c'est un téléchargement, et le
          navigateur sait le faire sans charger le journal en mémoire. */}
      <a className={cn(BUTTON.secondary, "max-md:min-h-11")} href={api.decisionsExportUrl(filters)} download="decisions.jsonl">
        {t("decisions.export")}
      </a>
    </div>
  );

  const body = decisions.isPending ? (
    <DecisionsSkeleton label={t("decisions.loading")} stacked={isMobile} />
  ) : (
    <>
      {rows.length === 0 ? (
        (
          <p className={isMobile ? "px-8 py-4 text-[15px] text-[var(--ohb-grouped-caption)]" : "text-sm text-muted-foreground"}>
            {t("decisions.empty")}
          </p>
        )
      ) : isMobile ? (
    /* Un GROUPE, pas des cartes détachées : chaque décision est une ligne
       d'un même journal, pas une tuile qu'on compare à sa voisine. */
    <InsetGroupedSection className="pt-0">
      {rows.map((decision) => (
        <DecisionCard key={decision.id} decision={decision} formatDate={formatDate} t={t} />
      ))}
    </InsetGroupedSection>
  ) : (
    <div className="scrollbar-subtle overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[7rem]">{t("decisions.colDecision")}</TableHead>
            <TableHead className="w-[10rem]">{t("decisions.colBot")}</TableHead>
            <TableHead>{t("decisions.colAction")}</TableHead>
            <TableHead className="w-[16rem]">{t("decisions.colWhy")}</TableHead>
            <TableHead className="w-[6rem]">{t("decisions.colType")}</TableHead>
            <TableHead className="w-[12rem]">{t("decisions.colWhen")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((decision) => (
            <DecisionRow key={decision.id} decision={decision} formatDate={formatDate} t={t} />
          ))}
        </TableBody>
      </Table>
    </div>
      )}
    </>
  );

  if (isMobile) {
    const segmented = (
      <>
        <div data-inset-grouped="" className="pt-2 pb-1">
          <MobileSegmented
            value={choice}
            onChange={setChoice}
            label={t("decisions.title")}
            idPrefix="decisions-seg"
            segments={FILTERS.map((filter) => ({ id: filter, label: t(FILTER_LABEL_KEY[filter]) }))}
          />
        </div>
        <div data-inset-grouped="" className="pt-1 pb-1">
          <MobileSegmented
            value={origin}
            onChange={setOrigin}
            label={t("decisions.originFilterLabel")}
            idPrefix="decisions-origin-seg"
            segments={ORIGIN_FILTERS.map((filter) => ({ id: filter, label: t(ORIGIN_FILTER_LABEL_KEY[filter]) }))}
          />
        </div>
      </>
    );
    /*
      Trois filtres et un téléchargement ne sont pas la même chose : les
      premiers étaient des pilules bleues, le second une quatrième pilule à la
      ligne d'en dessous : on ne voyait plus lequel changeait la vue et lequel
      écrivait un fichier. Les filtres deviennent le commutateur segmenté,
      l'export descend dans la barre d'actions.
    */
    return (
      <SettingsPane
        footer={
          <a className={BUTTON.secondary} href={api.decisionsExportUrl(filters)} download="decisions.jsonl">
            {t("decisions.export")}
          </a>
        }
      >
        {fleetAudit ? (
          <div className="px-4 pt-2">
            <FleetClientAudit decisions={<>{segmented}{body}</>} />
          </div>
        ) : (
          <>
            {segmented}
            {body}
          </>
        )}
      </SettingsPane>
    );
  }

  if (fleetAudit) {
    return (
      <SettingsPane>
        <FleetClientAudit
          decisions={
            <>
              {filtersBar}
              {body}
            </>
          }
        />
      </SettingsPane>
    );
  }

  return (
    <SettingsPane>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className={inModal ? "sr-only" : "text-base font-semibold tracking-tight"}>{t("decisions.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("decisions.description")}</p>
        </div>
        {filtersBar}
      </header>
      {body}
    </SettingsPane>
  );
}

function DecisionsSkeleton({ label, stacked }: { label: string; stacked: boolean }) {
  if (stacked) {
    return (
      <div role="status" aria-label={label} className="flex flex-col gap-2 px-4">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="space-y-2 rounded-[20px] bg-[var(--ohb-grouped-card)] px-4 py-3">
            <Skeleton className="h-5 w-16 rounded-full motion-reduce:animate-none" />
            <Skeleton className="h-4 w-24 motion-reduce:animate-none" />
            <Skeleton className="h-3.5 w-full motion-reduce:animate-none" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div role="status" aria-label={label} className="overflow-hidden rounded-lg border">
      <div className="h-10 border-b bg-muted/50" />
      <div className="divide-y">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <div key={index} className="flex items-center gap-4 px-3 py-3">
            <Skeleton className="h-5 w-16 shrink-0 rounded-full motion-reduce:animate-none" />
            <Skeleton className="h-4 w-24 shrink-0 motion-reduce:animate-none" />
            <Skeleton className="h-3.5 min-w-0 flex-1 motion-reduce:animate-none" />
            <Skeleton className="h-3.5 w-12 shrink-0 motion-reduce:animate-none" />
            <Skeleton className="h-3.5 w-28 shrink-0 motion-reduce:animate-none" />
          </div>
        ))}
      </div>
    </div>
  );
}

function decisionLabels(
  decision: DecisionDto,
  t: ReturnType<typeof useT>["t"],
) {
  const denied = decision.choice === "deny";
  return {
    denied,
    bot: decision.botName.trim() || t("decisions.unknownBot"),
    action: decision.action.trim() || t("decisions.unknownAction"),
    kind: decision.kind.trim() || t("decisions.unknownType"),
  };
}

function DecisionRow({
  decision,
  formatDate,
  t,
}: {
  decision: DecisionDto;
  formatDate: ReturnType<typeof useT>["formatDate"];
  t: ReturnType<typeof useT>["t"];
}) {
  const { denied, bot, action, kind } = decisionLabels(decision, t);
  return (
    <TableRow>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          <Badge variant={denied ? "destructive" : "secondary"}>
            {denied ? t("decisions.denied") : t("decisions.allowed")}
          </Badge>
          <OriginBadge decision={decision} t={t} />
        </div>
      </TableCell>
      <TableCell className="truncate font-medium">{bot}</TableCell>
      {/* Une commande peut faire 200 caractères : elle passe à la ligne
          (`break-all` restait sans effet sous le `nowrap` des cellules), sur
          les espaces d'abord, et s'arrête à trois lignes, le texte entier au
          survol. */}
      <TableCell className="min-w-48 font-mono text-xs whitespace-normal [overflow-wrap:anywhere]">
        <span className="line-clamp-3" title={action}>{action}</span>
      </TableCell>
      <TableCell className="text-muted-foreground text-xs whitespace-normal">
        <DecisionTrace decision={decision} />
      </TableCell>
      <TableCell className="text-muted-foreground text-xs">{kind}</TableCell>
      <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
        {formatDate(decision.issuedAt, {})}
      </TableCell>
    </TableRow>
  );
}

function DecisionCard({
  decision,
  formatDate,
  t,
}: {
  decision: DecisionDto;
  formatDate: ReturnType<typeof useT>["formatDate"];
  t: ReturnType<typeof useT>["t"];
}) {
  const { denied, bot, action, kind } = decisionLabels(decision, t);
  return (
    <li>
      <div data-inset-grouped-row="" className="relative flex min-h-16 flex-col justify-center gap-1 px-4 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 flex-1 truncate text-[17px] leading-[22px] font-medium text-[var(--ohb-grouped-label)]">
            {bot}
          </span>
          <span className="shrink-0 text-[13px] leading-4 text-[var(--ohb-grouped-caption)]">
            {formatDate(decision.issuedAt, {})}
          </span>
        </div>
        <p className="line-clamp-2 font-mono text-[13px] leading-4 break-all text-[var(--ohb-grouped-caption)]">
          {action}
        </p>
        <div className="flex items-center gap-2">
          <span
            className={
              denied
                ? "text-[13px] leading-4 text-destructive-text"
                : "text-[13px] leading-4 text-pos-700"
            }
          >
            {denied ? t("decisions.denied") : t("decisions.allowed")}
          </span>
          <OriginBadge decision={decision} t={t} />
          <span className="text-[13px] leading-4 text-[var(--ohb-grouped-caption)]">· {kind}</span>
        </div>
        <DecisionTrace decision={decision} className="text-[13px] leading-4 text-[var(--ohb-grouped-caption)]" />
      </div>
    </li>
  );
}

function OriginBadge({
  decision,
  t,
}: {
  decision: DecisionDto;
  t: ReturnType<typeof useT>["t"];
}) {
  return (
    <Badge variant="outline">
      {decision.origin === "human"
        ? t("decisions.originHuman")
        : decision.policy === "bypass"
          ? t("decisions.originPolicyBypass")
          : decision.policy === "auto"
            ? t("decisions.originPolicyAuto")
            : t("decisions.originPolicy")}
    </Badge>
  );
}
