import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, GitBranch, Loader2 } from "lucide-react";
import { AgentContextMeter, AgentLimitsCard, Button, Dialog, useIsMobile } from "@openedbot/browser-ui-kit";
import {
  groupWorkflowRuns,
  isWorkflowInFlight,
  visibleWorkflowGroups,
} from "@/lib/run/workflow-display";
import type { RunDto, WorkflowDto, WorkflowStatus } from "@openedbot/contracts-api";
import { queryKeys } from "../lib/api";
import { useT, type MessageKey } from "../lib/i18n";
import { WorkflowRecoveryDialog } from "./workflow-recovery-dialog";
import { useWorkflowRecovery } from "../lib/run/use-workflow-recovery";

const STATUS_KEYS: Record<WorkflowStatus, MessageKey> = {
  queued: "workflowOverview.status.queued",
  running: "workflowOverview.status.running",
  awaiting_approval: "workflowOverview.status.awaitingApproval",
  reconciling: "workflowOverview.status.reconciling",
  completed: "workflowOverview.status.completed",
  failed: "workflowOverview.status.failed",
  cancelled: "workflowOverview.status.cancelled",
  expired: "workflowOverview.status.expired",
  unknown: "workflowOverview.status.unknown",
};

const STEP_KIND_KEYS: Record<NonNullable<RunDto["stepKind"]>, MessageKey> = {
  root: "workflowOverview.stepKind.root",
  delegated: "workflowOverview.stepKind.delegated",
  continuation: "workflowOverview.stepKind.continuation",
  group: "workflowOverview.stepKind.group",
  memory: "workflowOverview.stepKind.memory",
  persona_draft: "workflowOverview.stepKind.persona_draft",
  compaction: "workflowOverview.stepKind.compaction",
};

/** Le statut d'une étape se lit dans la langue du reste du panneau. */
const RUN_STATUS_KEYS: Record<RunDto["status"], MessageKey> = {
  queued: "workflowOverview.runStatus.queued",
  pending: "workflowOverview.runStatus.queued",
  starting: "workflowOverview.runStatus.starting",
  running: "workflowOverview.runStatus.running",
  awaiting_approval: "workflowOverview.runStatus.awaitingApproval",
  completed: "workflowOverview.runStatus.completed",
  failed: "workflowOverview.runStatus.failed",
  cancelled: "workflowOverview.runStatus.cancelled",
};

/**
 * L'état durable des workflows, tenu HORS du fil : un bouton compact dans
 * l'en-tête de la conversation, et tout le détail dans une boîte de dialogue.
 * La conversation garde ainsi toute sa hauteur : une carte par message,
 * épinglée au-dessus du transcript, doublait la réponse déjà lue et poussait
 * la dernière bulle sous le composer.
 */
export function WorkflowOverview({
  threadId,
  workflows = [],
  runs,
}: {
  threadId: string;
  workflows?: WorkflowDto[];
  runs: RunDto[];
}) {
  const { t, formatDate, formatNumber } = useT();
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  // Ne reste que ce que le fil ne sait pas dire : la règle vit dans le core
  // (`isWorkflowWorthShowing`), pour que le mobile applique la même.
  const groups = visibleWorkflowGroups(groupWorkflowRuns(workflows, runs));
  const recovery = useWorkflowRecovery({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.thread(threadId) });
    },
  });

  if (!groups.length) return null;

  const act = recovery.act;

  // Une décision due prime sur le reste : c'est elle qui colore le bouton.
  const review = groups.find(({ workflow }) => workflow.recoveryState === "needs_review");
  const flying = groups.find(({ workflow }) => isWorkflowInFlight(workflow));
  const lead = review ?? flying ?? groups[groups.length - 1]!;
  const busy = !review && Boolean(flying);

  return (
    <>
      {isMobile ? (
        <button
          type="button"
          data-workflow-trigger=""
          onClick={() => setOpen(true)}
          title={t("workflowOverview.openDetail")}
          aria-label={`${t(STATUS_KEYS[lead.workflow.status])} ${lead.workflow.usedSteps}/${lead.workflow.maxSteps}. ${t("workflowOverview.openDetail")}`}
          className={`ohb-press relative flex size-11 shrink-0 items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            review ? "text-warn-700" : "text-muted-foreground"
          }`}
        >
          {review ? (
            <AlertTriangle className="size-6" aria-hidden />
          ) : busy ? (
            <Loader2 className="size-6 animate-spin" aria-hidden />
          ) : (
            <GitBranch className="size-6" aria-hidden />
          )}
          {groups.length > 1 ? (
            <span className="absolute top-1.5 right-1 flex size-4 items-center justify-center rounded-full bg-muted text-[10px] tabular-nums text-foreground">
              {groups.length}
            </span>
          ) : null}
        </button>
      ) : (
        <Button
          variant={review ? "secondary" : "ghost"}
          size="xs"
          onClick={() => setOpen(true)}
          title={t("workflowOverview.openDetail")}
          className={review ? "border border-warn-500/50 text-warn-700" : "text-muted-foreground"}
        >
          {review ? (
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
          ) : busy ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
          ) : (
            <GitBranch className="size-3.5 shrink-0" aria-hidden />
          )}
          <span className="ml-0.5 max-w-40 truncate">{t(STATUS_KEYS[lead.workflow.status])}</span>
          {/* La part d'autonomie déjà brûlée, en anneau : « 12/40 » disait
              deux nombres, l'anneau dit d'un coup d'oeil s'il reste de la
              marge. Le détail chiffré est dans la carte, à un clic. */}
          <AgentContextMeter
            className="ml-1.5"
            percent={lead.workflow.tokenBudget > 0
              ? (lead.workflow.usedTokens / lead.workflow.tokenBudget) * 100
              : 0}
            label={t("workflowOverview.tokensReadout", {
              used: formatNumber(lead.workflow.usedTokens),
              budget: formatNumber(lead.workflow.tokenBudget),
            })}
          />
          {groups.length > 1 ? (
            <span className="ml-1.5 rounded-full bg-muted px-1.5 text-[10px] tabular-nums">{groups.length}</span>
          ) : null}
          <span className="sr-only">{t("workflowOverview.openDetail")}</span>
        </Button>
      )}

      <WorkflowRecoveryDialog recovery={recovery} />

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("workflowOverview.title")}
        description={t("workflowOverview.dialogDescription")}
        closeLabel={t("common.close")}
        className="max-w-2xl"
      >
        <div className="space-y-4">
          {groups.map(({ workflow, steps, finalOutput }) => {
            const needsReview = workflow.recoveryState === "needs_review";
            const pending = recovery.isPending && recovery.variables?.workflowId === workflow.id;
            const failed = recovery.isError && recovery.variables?.workflowId === workflow.id;
            return (
              <section key={workflow.id} className="space-y-3 rounded-xl border border-border/70 p-3">
                <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-sm font-medium">{t(STATUS_KEYS[workflow.status])}</span>
                  {isWorkflowInFlight(workflow) ? (
                    <span className="text-xs text-muted-foreground">
                      {t("workflowOverview.deadline", { date: formatDate(workflow.deadlineAt) })}
                    </span>
                  ) : null}
                </header>

                {/* Ce que le workflow a consommé de son autonomie. Trois
                    libellés gris côte à côte disaient les mêmes chiffres sans
                    dire s'il en restait : la barre et les jauges répondent
                    d'un coup d'oeil. */}
                <AgentLimitsCard
                  budget={{
                    label: t("workflowOverview.tokensLabel"),
                    readout: t("workflowOverview.tokensReadout", {
                      used: formatNumber(workflow.usedTokens),
                      budget: formatNumber(workflow.tokenBudget),
                    }),
                    max: workflow.tokenBudget,
                    segments: [{
                      label: t("workflowOverview.tokensUsed"),
                      value: workflow.usedTokens,
                      color: "var(--color-agent-seg-6)",
                    }],
                  }}
                  limits={{
                    label: t("workflowOverview.budgetLabel"),
                    rows: [
                      {
                        id: "steps",
                        label: t("workflowOverview.stepsLabel", {
                          used: workflow.usedSteps,
                          max: workflow.maxSteps,
                        }),
                        used: workflow.maxSteps > 0 ? workflow.usedSteps / workflow.maxSteps : 0,
                        resets: null,
                      },
                      {
                        id: "handoffs",
                        label: t("workflowOverview.handoffsLabel", {
                          used: workflow.usedHandoffs,
                          max: workflow.maxHandoffs,
                        }),
                        used: workflow.maxHandoffs > 0
                          ? workflow.usedHandoffs / workflow.maxHandoffs
                          : 0,
                        resets: null,
                      },
                    ],
                  }}
                  freeLabel={t("workflowOverview.tokensFree")}
                  expandLabel={t("workflowOverview.tokensExpand")}
                  collapseLabel={t("workflowOverview.tokensCollapse")}
                />

                {needsReview ? (
                  <div className="rounded-lg border border-warn-500/40 bg-warn-100/50 p-3 text-sm dark:bg-warn-950/20" role="alert">
                    <div className="flex gap-2">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn-700" aria-hidden />
                      <div className="min-w-0 flex-1 space-y-2">
                        <div>
                          <p className="font-medium text-foreground">{t("workflowOverview.reviewTitle")}</p>
                          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{t("workflowOverview.reviewBody")}</p>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          <Button size="xs" variant="secondary" disabled={pending} onClick={() => act(workflow.id, "reconcile")}>
                            {pending && recovery.variables?.action === "reconcile" ? t("workflowOverview.working") : t("workflowOverview.reconcile")}
                          </Button>
                          <Button size="xs" variant="secondary" disabled={pending} onClick={() => act(workflow.id, "abandon")}>
                            {t("workflowOverview.abandon")}
                          </Button>
                          <Button size="xs" variant="danger" disabled={pending} onClick={() => act(workflow.id, "retry")}>
                            {t("workflowOverview.retry")}
                          </Button>
                        </div>
                        {failed ? (
                          <p className="text-xs text-destructive-text">
                            {recovery.error instanceof Error ? recovery.error.message : t("workflowOverview.actionFailed")}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ) : null}

                {steps.length ? (
                  <ol className="space-y-1.5">
                    {steps.map((run, position) => (
                      <li key={run.id} className="flex items-center gap-2 rounded-lg bg-muted/40 px-2.5 py-2 text-xs">
                        {run.status === "completed" ? (
                          <CheckCircle2 className="size-3.5 shrink-0 text-pos-700" aria-hidden />
                        ) : run.recoveryState === "needs_review" ? (
                          <AlertTriangle className="size-3.5 shrink-0 text-warn-700" aria-hidden />
                        ) : (
                          <span className="size-2 shrink-0 rounded-full bg-muted-foreground/50" aria-hidden />
                        )}
                        <span className="font-medium">
                          {t("workflowOverview.step", { index: (run.stepIndex ?? position) + 1 })}
                        </span>
                        {run.stepKind ? <span>{t(STEP_KIND_KEYS[run.stepKind])}</span> : null}
                        {run.stackDepth != null ? (
                          <span className="text-muted-foreground">{t("workflowOverview.stepDepth", { depth: run.stackDepth })}</span>
                        ) : null}
                        <span className="ml-auto text-muted-foreground">{t(RUN_STATUS_KEYS[run.status])}</span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-xs text-muted-foreground">{t("workflowOverview.noSteps")}</p>
                )}

                {finalOutput ? (
                  <div className="rounded-lg border border-pos-500/40 bg-pos-100/40 p-3 dark:bg-pos-950/20">
                    <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-pos-700">
                      <CheckCircle2 className="size-3.5" aria-hidden />
                      {t("workflowOverview.finalTitle")}
                    </p>
                    <p className="whitespace-pre-wrap wrap-anywhere text-sm text-foreground">{finalOutput}</p>
                  </div>
                ) : workflow.errorMessage ? (
                  <div className="rounded-lg bg-neg-100/40 px-3 py-2 text-xs text-destructive-text">
                    <span className="font-medium">{t("workflowOverview.errorTitle")} : </span>
                    {workflow.errorMessage}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      </Dialog>
    </>
  );
}
