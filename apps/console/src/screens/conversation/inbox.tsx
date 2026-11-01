import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { AlertTriangle, ChevronRight, Clock, Inbox, MessagesSquare, ShieldCheck, Users } from "lucide-react";
import { Button, cn, Dialog, useIsMobile } from "@openedbot/browser-ui-kit";
import type {
  InboxApprovalItemDto,
  InboxItemDto,
  InboxItemKind,
  InboxNeedsReviewItemDto,
} from "@openedbot/contracts-api";
import { api, queryKeys } from "../../lib/api";
import { BotFace } from "../../components/bot-face";
import { SiteHeader } from "../../components/dashboard/site-header";
import {
  InsetGroupedSection,
  insetGroupedRowClassName,
  MobileSegmented,
} from "../../components/mobile/inset-grouped";
import { BUTTON, EmptyState } from "../../components/settings/primitives";
import { WorkflowRecoveryDialog } from "../../components/workflow-recovery-dialog";
import { useT, type MessageKey } from "../../lib/i18n";
import { useWorkflowRecovery } from "../../lib/use-workflow-recovery";

type Filter = "all" | InboxItemKind;
type OpenDialog =
  | { kind: "approval"; item: InboxApprovalItemDto }
  | { kind: "review"; item: InboxNeedsReviewItemDto };

/**
 * `shortKey` : le libellé du contrôle segmenté iOS.
 *
 * Quatre segments dans 430 pt laissent ~14 caractères chacun. « On vous
 * attend » y devenait « On vous at… » : un segment tronqué ne se lit pas, il
 * se devine. Le desktop garde la phrase entière, il a la largeur.
 */
const FILTERS: ReadonlyArray<{ id: Filter; labelKey: MessageKey; shortKey?: MessageKey }> = [
  { id: "all", labelKey: "inbox.filterAll" },
  { id: "approval", labelKey: "inbox.filterApproval" },
  { id: "needs_review", labelKey: "inbox.filterNeedsReview" },
  { id: "needs_you", labelKey: "inbox.filterNeedsYou", shortKey: "inbox.filterNeedsYouShort" },
];

const KIND_KEYS: Record<InboxItemKind, MessageKey> = {
  approval: "inbox.kindApproval",
  needs_review: "inbox.kindNeedsReview",
  needs_you: "inbox.kindNeedsYou",
};

/**
 * La boîte « À traiter ».
 *
 * Remplace `/history` : on n'y liste plus chaque exécution avec son coût,
 * seulement ce qui attend une décision : une approbation, une exécution à
 * vérifier, un salon où l'on nous attend. Le reste (exécutions terminées,
 * messages ordinaires) vit déjà dans les conversations.
 *
 * Approbation et revue s'ouvrent en `alertdialog` : on tranche ici, on
 * n'envoie plus vers le fil pour un `window.confirm`.
 */
export function InboxScreen() {
  const { t, formatNumber } = useT();
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const initialFilter = useRouterState({ select: (state): Filter => {
    const kind = (state.location.search as { kind?: unknown }).kind;
    return kind === "approval" || kind === "needs_review" || kind === "needs_you" ? kind : "all";
  } });
  const [filter, setFilter] = useState<Filter>(initialFilter);
  useEffect(() => setFilter(initialFilter), [initialFilter]);
  const [open, setOpen] = useState<OpenDialog | null>(null);

  const inbox = useQuery({
    queryKey: queryKeys.inbox,
    queryFn: api.inbox,
    refetchInterval: 15_000,
  });
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const canWrite = me.data?.kind === "session" && me.data.session.canWrite;

  const items = inbox.data?.items ?? [];
  const counts = inbox.data?.counts;
  const filtered = useMemo(
    () => (filter === "all" ? items : items.filter((item) => item.kind === filter)),
    [items, filter],
  );

  const recovery = useWorkflowRecovery({
    onSuccess: () => {
      setOpen(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.inbox });
    },
  });

  const decide = useMutation({
    mutationFn: ({ approvalId, choice }: { approvalId: string; choice: "once" | "deny" }) =>
      api.respondApproval(approvalId, { choice }),
    onSuccess: () => {
      setOpen(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.inbox });
      void queryClient.invalidateQueries({ queryKey: queryKeys.roster });
    },
  });

  const goToThread = (item: InboxItemDto) => {
    if (item.groupId) {
      void navigate({ to: "/g/$groupId", params: { groupId: item.groupId } });
      return;
    }
    if (!item.botId) return;
    // Un bot, un fil. `?task=` ne désigne plus une session mais une branche
    // de variante de message, et elle vit sous `/bot/:botId` comme le reste.
    void navigate({
      to: "/bot/$botId",
      params: { botId: item.botId },
      search: item.isDefaultThread ? {} : { task: item.threadId },
    });
  };

  const activate = (item: InboxItemDto) => {
    if (item.kind === "approval") {
      setOpen({ kind: "approval", item });
      return;
    }
    if (item.kind === "needs_review") {
      setOpen({ kind: "review", item });
      return;
    }
    goToThread(item);
  };

  const countFor = (id: Filter): number | undefined => {
    if (!counts) return undefined;
    if (id === "all") return counts.total;
    if (id === "approval") return counts.approval;
    if (id === "needs_review") return counts.needsReview;
    return counts.needsYou;
  };

  const segments = FILTERS.map((entry) => {
    const count = countFor(entry.id);
    return {
      id: entry.id,
      label: t(entry.shortKey ?? entry.labelKey),
      count: count ? formatNumber(count) : null,
    };
  });

  const dialogs = (
    <>
      <ApprovalDialog
        item={open?.kind === "approval" ? open.item : null}
        canWrite={canWrite}
        deciding={decide.isPending}
        error={decide.isError ? decide.error : null}
        onClose={() => {
          if (!decide.isPending) setOpen(null);
        }}
        onOpenThread={(item) => {
          setOpen(null);
          goToThread(item);
        }}
        onDecide={(choice) => {
          if (open?.kind !== "approval") return;
          decide.mutate({ approvalId: open.item.approvalId, choice });
        }}
      />

      <ReviewDialog
        item={open?.kind === "review" ? open.item : null}
        canWrite={canWrite}
        pending={recovery.isPending}
        action={recovery.variables?.action ?? null}
        error={recovery.isError ? recovery.error : null}
        onClose={() => {
          if (!recovery.isPending && !recovery.confirming) setOpen(null);
        }}
        onOpenThread={(item) => {
          setOpen(null);
          goToThread(item);
        }}
        onAct={(item, action) => recovery.act(item.workflowId, action)}
      />

      <WorkflowRecoveryDialog recovery={recovery} />
    </>
  );

  /*
    Téléphone : l'écran d'une app, pas une page.

    Le fond passe au canvas groupé (il était blanc, seul écran du drawer à
    l'être), les quatre filtres deviennent un contrôle segmenté iOS au lieu de
    quatre `Button ghost` qui se lisent comme des onglets web, et les entrées
    deviennent une carte inset de lignes 64 pt : pas des boîtes bordées
    empilées avec 8 px entre elles.
  */
  if (isMobile) {
    return (
      <>
        <SiteHeader title={<span className="truncate">{t("inbox.title")}</span>} />
        <div
          data-mobile-scroll=""
          data-mobile-settings=""
          className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto bg-[var(--ohb-grouped-canvas)] pb-[max(1.5rem,var(--ohb-safe-bottom))]"
        >
          <h1 className="sr-only">{t("inbox.title")}</h1>
          <p className="px-8 pt-3 text-[13px] leading-4 text-[var(--ohb-grouped-caption)]">
            {t("inbox.subtitle")}
          </p>
          <div data-inset-grouped="" className="px-4 pt-3">
            <MobileSegmented
              value={filter}
              onChange={setFilter}
              segments={segments}
              label={t("inbox.title")}
              controls="inbox-list"
              idPrefix="inbox-seg"
            />
          </div>

          <div id="inbox-list" role="tabpanel">
            {inbox.isPending ? (
              <p className="px-8 pt-6 text-[15px] leading-5 text-[var(--ohb-grouped-caption)]">
                {t("inbox.loading")}
              </p>
            ) : inbox.isError ? (
              <EmptyState
                icon={<AlertTriangle aria-hidden />}
                title={t("inbox.loadFailed")}
                description={t("inbox.emptyScope")}
                actions={
                  <button type="button" onClick={() => void inbox.refetch()} className={BUTTON.secondary}>
                    {t("inbox.retry")}
                  </button>
                }
              />
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={<Inbox aria-hidden />}
                title={t("inbox.empty")}
                description={t("inbox.emptyScope")}
              />
            ) : (
              <InsetGroupedSection>
                {filtered.map((item) => (
                  <InboxMobileRow
                    key={`${item.kind}:${item.id}`}
                    item={item}
                    onOpen={() => activate(item)}
                  />
                ))}
              </InsetGroupedSection>
            )}
          </div>
        </div>
        {dialogs}
      </>
    );
  }

  return (
    <>
      <SiteHeader title={<span className="truncate">{t("inbox.title")}</span>} />

      {/* Un `h1` par page : le cadre applicatif n'en pose aucun. Pas de
          `<main>` ici : `SidebarInset` en rend déjà un. */}
      <div data-mobile-scroll="" className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto w-full max-w-4xl space-y-4">
          <div className="space-y-3">
            <h1 className="sr-only">{t("inbox.title")}</h1>
            <p className="text-sm text-muted-foreground">{t("inbox.subtitle")}</p>
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("inbox.title")}>
              {FILTERS.map((entry) => {
                const count = countFor(entry.id);
                return (
                  <Button
                    key={entry.id}
                    size="sm"
                    variant={filter === entry.id ? "secondary" : "ghost"}
                    aria-pressed={filter === entry.id}
                    onClick={() => setFilter(entry.id)}
                  >
                    {t(entry.labelKey)}
                    {count ? <span className="ml-1 tabular-nums opacity-70">{count}</span> : null}
                  </Button>
                );
              })}
            </div>
          </div>

          {inbox.isPending ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t("inbox.loading")}</p>
          ) : inbox.isError ? (
            <div className="rounded-xl border border-dashed border-border py-12 text-center">
              <p className="text-sm font-medium text-foreground">{t("inbox.loadFailed")}</p>
              <button type="button" onClick={() => void inbox.refetch()} className={`${BUTTON.small} mt-3`}>
                {t("inbox.retry")}
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border py-12 text-center">
              <p className="text-sm font-medium text-foreground">{t("inbox.empty")}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("inbox.emptyScope")}</p>
            </div>
          ) : (
            <ul className="space-y-2">
              {filtered.map((item) => (
                <InboxRow
                  key={`${item.kind}:${item.id}`}
                  item={item}
                  onOpen={() => activate(item)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      {dialogs}
    </>
  );
}

/**
 * Une entrée « À traiter » sur téléphone : la ligne d'une messagerie iOS.
 *
 * 64 pt : visage 40, nom et heure sur la première ligne, la raison d'être là
 * sur la seconde. Le genre (approbation / à vérifier / on vous attend) est
 * porté par une pastille d'icône colorée, pas par un badge de texte en bout de
 * ligne qui volait la largeur du nom.
 */
function InboxMobileRow({ item, onOpen }: { item: InboxItemDto; onOpen: () => void }) {
  const { t, formatDate } = useT();
  const tone =
    item.kind === "needs_review"
      ? "bg-neg-soft text-destructive-text"
      : item.kind === "approval"
        ? "bg-warn-soft text-warn-700"
        : "bg-info-soft text-info-700";
  const Icon = item.kind === "needs_review" ? AlertTriangle : item.kind === "approval" ? ShieldCheck : Users;
  const detail =
    item.kind === "approval"
      ? (item.summary ?? t("inbox.noSummary"))
      : item.kind === "needs_review"
        ? (item.errorMessage ?? t("workflowOverview.reviewTitle"))
        : (item.groupName ?? t(item.groupId ? "inbox.kindGroup" : "inbox.kindDm"));

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-label={item.kind === "needs_you" ? t("inbox.openThread") : t("inbox.openDecision")}
        data-inbox-item={item.kind}
        data-inbox-id={item.id}
        data-inset-grouped-row=""
        className={cn(insetGroupedRowClassName, "min-h-16")}
      >
        <span className="relative shrink-0">
          <BotFace
            name={item.botName ?? "bot"}
            seed={item.botSlug ?? item.id}
            face={item.botFace}
            className="size-10"
          />
          <span
            aria-hidden
            className={cn(
              "absolute -right-0.5 -bottom-0.5 flex size-[18px] items-center justify-center rounded-full ring-2 ring-[var(--ohb-grouped-card)]",
              tone,
            )}
          >
            <Icon className="size-3" />
          </span>
        </span>
        <span className="min-w-0 flex-1 py-2.5">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-left text-[17px] leading-[22px] text-[var(--ohb-grouped-label)]">
              {item.botName ?? ":"}
            </span>
            <span className="shrink-0 text-[13px] leading-4 text-[var(--ohb-grouped-caption)]">
              {formatDate(item.occurredAt)}
            </span>
          </span>
          <span className="mt-0.5 line-clamp-2 block text-left text-[13px] leading-4 text-[var(--ohb-grouped-caption)]">
            {detail}
          </span>
          {item.kind === "approval" ? (
            <span className="mt-0.5 flex items-center gap-1 text-[13px] leading-4 text-warn-700">
              <Clock className="size-3" aria-hidden />
              {t("inbox.expires", { date: formatDate(item.expiresAt) })}
            </span>
          ) : null}
        </span>
        <ChevronRight aria-hidden className="size-5 shrink-0 self-center text-[var(--ohb-grouped-chevron)]" />
      </button>
    </li>
  );
}

function InboxRow({
  item,
  onOpen,
}: {
  item: InboxItemDto;
  onOpen: () => void;
}) {
  const { t, formatDate } = useT();

  const icon =
    item.kind === "needs_review" ? (
      <AlertTriangle className="size-4 shrink-0 text-warn-700" aria-hidden />
    ) : item.kind === "approval" ? (
      <ShieldCheck className="size-4 shrink-0 text-warn-700" aria-hidden />
    ) : (
      <Users className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    );

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        title={item.kind === "needs_you" ? t("inbox.openThread") : t("inbox.openDecision")}
        data-inbox-item={item.kind}
        data-inbox-id={item.id}
        className="flex w-full items-start gap-3 rounded-xl border border-border/70 bg-background px-3 py-2.5 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="pt-0.5">{icon}</span>

        <BotFace
          name={item.botName ?? "bot"}
          seed={item.botSlug ?? item.id}
          face={item.botFace}
          className="size-6 shrink-0"
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium">{item.botName ?? ":"}</span>
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              {item.groupId ? <Users className="size-3" aria-hidden /> : <MessagesSquare className="size-3" aria-hidden />}
              <span className="max-w-40 truncate">
                {item.groupName ?? t(item.groupId ? "inbox.kindGroup" : "inbox.kindDm")}
              </span>
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span>{formatDate(item.occurredAt)}</span>
            {item.kind === "approval" ? (
              <span className="flex items-center gap-1">
                <Clock className="size-3" aria-hidden />
                {t("inbox.expires", { date: formatDate(item.expiresAt) })}
              </span>
            ) : null}
          </div>

          {item.kind === "approval" && item.summary ? (
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.summary}</p>
          ) : null}

          {item.kind === "needs_review" && item.errorMessage ? (
            <p className="mt-1 line-clamp-2 text-xs text-destructive-text">{item.errorMessage}</p>
          ) : null}
        </div>

        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {t(KIND_KEYS[item.kind])}
        </span>
      </button>
    </li>
  );
}

function ApprovalDialog({
  item,
  canWrite,
  deciding,
  error,
  onClose,
  onOpenThread,
  onDecide,
}: {
  item: InboxApprovalItemDto | null;
  canWrite: boolean;
  deciding: boolean;
  error: unknown;
  onClose: () => void;
  onOpenThread: (item: InboxApprovalItemDto) => void;
  onDecide: (choice: "once" | "deny") => void;
}) {
  const { t, formatDate } = useT();

  return (
    <Dialog
      open={item !== null}
      onClose={onClose}
      role="alertdialog"
      title={t("inbox.kindApproval")}
      description={item ? t("inbox.approvalHint", { bot: item.botName ?? ":", date: formatDate(item.expiresAt) }) : undefined}
      closeLabel={t("common.close")}
      className="max-w-lg"
      footerClassName="grid grid-cols-1 justify-items-stretch sm:grid-cols-2"
      footer={
        item ? (
          <>
            <button
              type="button"
              disabled={deciding}
              onClick={() => onOpenThread(item)}
              className={`${BUTTON.secondary} w-full`}
            >
              {t("inbox.openThread")}
            </button>
            {canWrite ? (
              <>
                <button
                  type="button"
                  disabled={deciding}
                  onClick={() => onDecide("deny")}
                  className={`${BUTTON.secondary} w-full`}
                >
                  {deciding ? t("gateCard.deciding") : t("gateCard.deny")}
                </button>
                <button
                  type="button"
                  disabled={deciding}
                  onClick={() => onDecide("once")}
                  className={`${BUTTON.primary} w-full sm:col-span-2`}
                >
                  {deciding ? t("gateCard.deciding") : t("gateCard.allowOnce")}
                </button>
              </>
            ) : null}
          </>
        ) : null
      }
    >
      {item ? (
        <div className="space-y-3">
          <p className="text-sm leading-6 text-foreground/80">
            {item.summary ?? t("inbox.noSummary")}
          </p>
          {error ? (
            <p className="text-destructive-text">
              {error instanceof Error ? error.message : t("gateCard.decisionFailed")}
            </p>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}

function ReviewDialog({
  item,
  canWrite,
  pending,
  action,
  error,
  onClose,
  onOpenThread,
  onAct,
}: {
  item: InboxNeedsReviewItemDto | null;
  canWrite: boolean;
  pending: boolean;
  action: "reconcile" | "abandon" | "retry" | null;
  error: unknown;
  onClose: () => void;
  onOpenThread: (item: InboxNeedsReviewItemDto) => void;
  onAct: (item: InboxNeedsReviewItemDto, action: "reconcile" | "abandon" | "retry") => void;
}) {
  const { t } = useT();

  return (
    <Dialog
      open={item !== null}
      onClose={onClose}
      role="alertdialog"
      title={t("inbox.kindNeedsReview")}
      description={t("workflowOverview.reviewBody")}
      closeLabel={t("common.close")}
      className="max-w-lg"
      footerClassName="grid grid-cols-1 justify-items-stretch sm:grid-cols-2"
      footer={
        item && canWrite ? (
          <>
            {item.status === "unknown" ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => onAct(item, "reconcile")}
                className={`${BUTTON.secondary} w-full`}
              >
                {pending && action === "reconcile" ? t("workflowOverview.working") : t("workflowOverview.reconcile")}
              </button>
            ) : (
              <button
                type="button"
                disabled={pending}
                onClick={() => onAct(item, "abandon")}
                className={`${BUTTON.secondary} w-full`}
              >
                {t("workflowOverview.abandon")}
              </button>
            )}
            <button
              type="button"
              disabled={pending}
              onClick={() => onAct(item, "retry")}
              className={`${BUTTON.danger} w-full`}
            >
              {t("workflowOverview.retry")}
            </button>
          </>
        ) : null
      }
    >
      {item ? (
        <div className="space-y-3">
          {item.errorMessage ? (
            <p className="text-sm leading-6 wrap-anywhere text-destructive-text">{item.errorMessage}</p>
          ) : (
            <p className="text-sm leading-6 text-foreground/80">{t("workflowOverview.reviewTitle")}</p>
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-text-tertiary">
            <button
              type="button"
              disabled={pending}
              onClick={() => onOpenThread(item)}
              className="cursor-pointer font-medium text-foreground hover:text-text-tertiary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("inbox.openThread")}
            </button>
            {canWrite && item.status === "unknown" ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => onAct(item, "abandon")}
                className="cursor-pointer font-medium text-foreground hover:text-text-tertiary disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("workflowOverview.abandon")}
              </button>
            ) : null}
          </div>
          {error ? (
            <p className="text-destructive-text">
              {error instanceof Error ? error.message : t("workflowOverview.actionFailed")}
            </p>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
