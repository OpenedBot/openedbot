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
import { SettingsTableFrame } from "../../../components/settings/settings-table-frame";
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
 * The decision journal: what was authorized or refused, and on what.
 *
 * Read only: the database grants refuse `UPDATE` and `DELETE` on the
 * journal's human rows. The section lives in settings, next to the
 * policies it records.
 */
export function DecisionsSettings() {
  const { t, formatDate } = useT();
  // In the modal, its header already carries the title: this one stays for screen readers.
  const isMobile = useIsMobile();
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
      {/* A link and not a button: it is a download, and the
          browser knows how to do it without loading the journal into memory. */}
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
          <p className={isMobile ? "px-8 py-4 text-[15px] text-[var(--openedbot-grouped-caption)]" : "text-sm text-muted-foreground"}>
            {t("decisions.empty")}
          </p>
        )
      ) : isMobile ? (
    /* A GROUP, not detached cards: each decision is a row
       of one journal, not a tile one compares with its neighbour. */
    <InsetGroupedSection className="pt-0">
      {rows.map((decision) => (
        <DecisionCard key={decision.id} decision={decision} formatDate={formatDate} t={t} />
      ))}
    </InsetGroupedSection>
  ) : (
    <SettingsTableFrame className="scrollbar-subtle overflow-x-auto">
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
    </SettingsTableFrame>
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
      Three filters and a download are not the same thing: the
      first were blue pills, the second a fourth pill on the
      line below: one could no longer see which changed the view and which
      wrote a file. The filters become the segmented control,
      the export moves down into the action bar.
    */
    return (
      <SettingsPane
        footer={
          <a className={BUTTON.secondary} href={api.decisionsExportUrl(filters)} download="decisions.jsonl">
            {t("decisions.export")}
          </a>
        }
      >
        {segmented}
        {body}
      </SettingsPane>
    );
  }

  return (
    <SettingsPane>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-base font-semibold tracking-tight">{t("decisions.title")}</h1>
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
          <div key={index} className="space-y-2 rounded-[20px] bg-[var(--openedbot-grouped-card)] px-4 py-3">
            <Skeleton className="h-5 w-16 rounded-full motion-reduce:animate-none" />
            <Skeleton className="h-4 w-24 motion-reduce:animate-none" />
            <Skeleton className="h-3.5 w-full motion-reduce:animate-none" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <SettingsTableFrame role="status" aria-label={label}>
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
    </SettingsTableFrame>
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
      {/* A command can be 200 characters: it wraps
          (`break-all` had no effect under the cells' `nowrap`), at
          spaces first, and stops at three lines, the whole text on
          hover. */}
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
          <span className="min-w-0 flex-1 truncate text-[17px] leading-[22px] font-medium text-[var(--openedbot-grouped-label)]">
            {bot}
          </span>
          <span className="shrink-0 text-[13px] leading-4 text-[var(--openedbot-grouped-caption)]">
            {formatDate(decision.issuedAt, {})}
          </span>
        </div>
        <p className="line-clamp-2 font-mono text-[13px] leading-4 break-all text-[var(--openedbot-grouped-caption)]">
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
          <span className="text-[13px] leading-4 text-[var(--openedbot-grouped-caption)]">· {kind}</span>
        </div>
        <DecisionTrace decision={decision} className="text-[13px] leading-4 text-[var(--openedbot-grouped-caption)]" />
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
