import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Copy, ShieldAlert } from "lucide-react";
import type { ApprovalAlwaysChoice, ApprovalRequestDto } from "@openedbot/contracts-api";
import { Button, cn, toast } from "@openedbot/browser-ui-kit";
import { api, queryKeys } from "../lib/api";
import { gatePhrase } from "../lib/runtime/gate-phrase";
import { useT } from "../lib/i18n";
import { CARD_DESCRIPTION, CARD_TITLE, SETTINGS_INSET, SETTINGS_SHELL, SETTINGS_SHELL_HEADER } from "./settings/primitives";

type GateChoice = "once" | "deny" | ApprovalAlwaysChoice;

/** Past that, the command is folded: a gate must not drown the thread. */
const COLLAPSED_LINES = 5;

/**
 * The authorization request has two coordinated representations: a
 * trace in the thread and, for as long as it is open, a decision at the edge of the
 * composer. `inline` stays available for the standalone surfaces.
 *
 * It is the central piece of the permission broker: no risky action leaves
 * without a decision made for it.
 *
 * The drawing is that of a BoardUI notification (16 px card, round icon,
 * title 14/20 medium, body 14/20, secondary then primary actions) and of the
 * Permission menu (one line for what is asked, one truncated line for who
 * asks). The command scrolls inside the card: it does not push the page.
 *
 * Two buttons, plus a third when the server offers it. Hermes accepts
 * four, but its `session` and `always` grant a permission the host
 * keeps without openedbot: they stay refused by the API and the database. openedbot's « Toujours »
 * (PERM2-4) is something else: a grant of this tool on this bot, or
 * the runtime's terminal switch, revocable in settings; Hermes
 * receives `once`. The server decides whether it is offered (`alwaysOffered`) and
 * recomputes it on click. Voice never offers it.
 */
export function GateCard({
  approval,
  embedded = false,
  mode = "inline",
  requester,
  queue,
}: {
  approval: ApprovalRequestDto;
  /**
   * A request that comes from a `tool.call` lives in the same card as the tool.
   * In `summary` mode, it never duplicates the dock's controls.
   */
  embedded?: boolean;
  /** The timeline keeps the trace; the dock near the composer carries the decision. */
  mode?: "inline" | "summary" | "dock";
  requester?: string;
  queue?: { index: number; total: number };
}) {
  const { t, plural } = useT();
  const commandId = `gate-command-${approval.id}-${mode}`;
  const queryClient = useQueryClient();
  const choices = approval.choices.filter((choice): choice is "once" | "deny" => choice === "once" || choice === "deny");
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [technical, setTechnical] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  const always: ApprovalAlwaysChoice | null = approval.alwaysOffered ?? null;
  const decide = useMutation({
    mutationFn: (choice: GateChoice) => api.respondApproval(approval.id, { choice }),
    onSuccess: (response) => {
      // The gate leaves `once` either way; a "Toujours" not recorded is said.
      if (response?.always && !response.always.saved) toast.error(t("gateCard.alwaysNotSaved"));
      void queryClient.invalidateQueries({ queryKey: queryKeys.thread(approval.threadId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.roster });
    },
    // A refusal from the server changes the gate's state as surely as a
    // success (measured on 18-08-2026): on a 409 `APPROVAL_REQUEST_EXPIRED`, the
    // thread kept its cached `approvals` list (the SSE does not carry it, see
    // `use-thread-stream.ts`), so the composer stayed disabled on « Une
    // décision est en attente ci-dessus… » while the server no longer had
    // any open request. Reloading is the only gesture that gives the client back
    // what the server already knows.
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.thread(approval.threadId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.roster });
    },
  });

  const pending = decide.isPending;
  const settled = decide.isSuccess;
  const chosen = pending ? decide.variables : null;
  const live = approval.status === "pending" && !pending && !settled;
  const hasDecision = mode !== "summary";
  const dock = mode === "dock";

  // Gate identified: the console's sentence replaces the plugin's text
  // host (English). The raw text stays in a folded detail.
  const phrase = gatePhrase(approval, t);
  const lines = approval.action.split("\n");
  const overflowing = lines.length > COLLAPSED_LINES;
  // The dock is where the operator decides: it never hides a
  // part of the command. Long actions scroll inside their frame.
  const visible = dock ? lines : overflowing && !expanded ? lines.slice(0, COLLAPSED_LINES) : lines;
  // Both buttons stay clickable even if lines are still
  // hidden: an `ask_user` behind a gate must never stay stuck
  // because the card has not finished unfolding. `hidden` now serves only
  // the visual hint at the bottom of the card.
  const hidden = !phrase && !dock && overflowing && !expanded;

  // NO single keystroke authorizes. A gate is not an `ask_user`: one
  // grants the execution of a command there, not an answer. A « 1 » badge as
  // in `AskUserCard` was enough to grant a permission never read: the
  // composer disables itself when the gate arrives, focus falls back on
  // `body`, and a « 1 » meant for a list went out as an approval. What remains is
  // native Tab, ↵ on the focused button, and Escape which REFUSES, the only
  // direction where an accidental keystroke costs only a new request.
  const card = useRef<HTMLDivElement | null>(null);

  // Focus is taken only if this card is the ONLY open gate: with
  // several, the first in the tree would have stolen it while the thread
  // shows the last one, and Escape would have refused an off-screen request.
  useEffect(() => {
    if (!live || !hasDecision) return;
    const node = card.current;
    if (!node || document.querySelectorAll("[data-approval-decision]").length > 1) return;
    const active = document.activeElement;
    if (active && active !== document.body && !node.contains(active)) return;
    node.focus({ preventScroll: true });
  }, [hasDecision, live]);

  // A synchronous lock: `isPending` exists only on the next render, two
  // close activations (Escape while the click is leaving) sent two
  // decisions of which only the first was kept by the server.
  const sent = useRef(false);
  const respond = (choice: GateChoice) => {
    if (!hasDecision || !live || sent.current) return;
    sent.current = true;
    decide.mutate(choice, { onError: () => { sent.current = false; } });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!hasDecision) return;
    if (event.key !== "Escape" || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
    if (!choices.includes("deny")) return;
    event.preventDefault();
    respond("deny");
  };

  const copy = () => {
    void navigator.clipboard?.writeText(approval.action).then(() => {
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1600);
    }).catch(() => undefined);
  };

  // In the thread, the request fits in ONE row of the turn's trace. The
  // whole command and the decision live in the dock near the composer:
  // two full cards repeated the same command one under the other.
  if (!hasDecision) {
    return (
      <div
        data-approval-id={approval.id}
        data-approval-summary=""
        role="group"
        aria-label={t("gateCard.title")}
        aria-describedby={commandId}
        className="flex min-w-0 max-w-full flex-col gap-0.5 py-0.5 text-body-regular text-muted-foreground"
      >
        <div className="flex w-fit max-w-full min-w-0 items-center gap-2">
          <span aria-hidden className="relative flex size-4 shrink-0 items-center justify-center bg-background text-warn-700">
            <ShieldAlert className="size-3.5" />
          </span>
          <span className="shrink-0 text-foreground">{t("gateCard.title")}</span>
          {approval.kind ? (
            <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/80">{approval.kind}</span>
          ) : null}
        </div>
        <p
          id={commandId}
          title={phrase ?? approval.action}
          className={cn(
            "ml-6 flex min-w-0 max-w-full items-baseline gap-2 text-[11px] text-muted-foreground/80",
            !phrase && "font-mono",
          )}
        >
          <span className="min-w-0 truncate">{phrase ?? lines[0]}</span>
          {!phrase && lines.length > 1 ? <span className="shrink-0 tabular-nums">+{lines.length - 1}</span> : null}
        </p>
        <p className="ml-6 flex items-center gap-2 text-xs text-muted-foreground">
          <span aria-hidden className="size-1.5 rounded-full bg-warn-700" />
          {t("gateCard.waitingBelow")}
        </p>
      </div>
    );
  }

  const asked = approval.kind?.trim() || t("gateCard.title");
  const review = reviewLine(approval.review, t);
  const askedBy = requester ? t("gateCard.requester", { name: requester }) : null;
  // BoardUI notification: secondary h-8 for a fine pointer, 44 px for touch.
  // `flex-basis` 9rem: one row as long as both fit, otherwise a stack
  // pleine largeur, Allow once en dernier.
  const actionClass = "min-h-11 flex-[1_1_9rem] px-3 fine:h-8 fine:min-h-8 fine:w-auto fine:flex-none";

  // Framed (dock, inline): the settings card in two layers (`SETTINGS_SHELL`,
  // `DESIGN.md` › Bureau › Carte). The tray carries who asks for what; the
  // inset card carries the request and the decision. Embedded in a tool card,
  // the frame is already drawn: only the flat layout remains.
  const framed = dock || !embedded;
  // The header names the situation, not the tool: a pending request, in the
  // amber of the thread's trace (`summary` above), and who asks. The tool
  // keeps its identifier, as code, on the right.
  const header = (
    <div className="flex min-w-0 items-start gap-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          <ShieldAlert aria-hidden className="size-4 shrink-0 text-warn-700" />
          <p className={cn("min-w-0 truncate", CARD_TITLE)}>{t("gateCard.title")}</p>
        </div>
        {askedBy ? (
          <p className={cn("ml-6 truncate", CARD_DESCRIPTION)} title={askedBy}>{askedBy}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 pt-px">
        {approval.kind?.trim() ? (
          <code className="max-w-40 truncate rounded-md border border-border/60 bg-card px-1.5 py-0.5 font-mono text-[12px] leading-4 text-muted-foreground">
            {approval.kind.trim()}
          </code>
        ) : null}
        {queue && queue.total > 1 ? (
          <span className="rounded-full bg-background-tertiary-default px-2 py-0.5 text-caption-1-medium tabular-nums text-text-tertiary">
            {t("gateCard.queue", { index: queue.index, total: queue.total })}
          </span>
        ) : null}
      </div>
    </div>
  );

  return (
    <div
      ref={card}
      data-approval-id={approval.id}
      data-approval-decision={hasDecision ? "" : undefined}
      data-approval-summary={!hasDecision ? "" : undefined}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      role="group"
      aria-label={askedBy ? `${asked}, ${askedBy}` : asked}
      aria-describedby={commandId}
      className={cn(
        "group/gate relative min-w-0 max-w-full outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring",
        dock
          ? cn(SETTINGS_SHELL, "w-full shadow-dropdown")
          : embedded
            ? "overflow-hidden border-t border-border-button-default"
            : cn(SETTINGS_SHELL, "animate-agent-card-in my-3 w-full max-w-[85%] self-start"),
      )}
    >
      {framed ? <div className={SETTINGS_SHELL_HEADER}>{header}</div> : null}
      <div className={framed ? SETTINGS_INSET : undefined}>
      <div className={framed ? "p-4 [&>:first-child]:mt-0" : "px-4 py-3"}>
        {framed ? null : header}

        {phrase ? (
          <p id={commandId} data-approval-phrase="" className="mt-3 text-body-regular text-text-primary wrap-anywhere">
            {phrase}
          </p>
        ) : approval.detail ? (
          <p className="mt-3 text-body-regular text-text-secondary">{approval.detail}</p>
        ) : null}

        {review ? (
          <p data-approval-review={approval.review?.reason} className="mt-2 break-words text-body-regular text-text-tertiary">
            {review}
          </p>
        ) : null}

        {phrase ? (
          <button
            type="button"
            aria-expanded={technical}
            aria-controls={`${commandId}-raw`}
            onClick={() => setTechnical(!technical)}
            className="mt-2 flex min-h-8 items-center gap-1.5 text-left text-caption-1-regular text-text-tertiary outline-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring coarse:min-h-11"
          >
            <ChevronDown
              aria-hidden
              className={`size-3.5 shrink-0 transition-transform motion-reduce:transition-none ${technical ? "rotate-180" : ""}`}
            />
            <span>{technical ? t("gateCard.technicalDetailsHide") : t("gateCard.technicalDetails")}</span>
          </button>
        ) : null}

        {/* A `routine_manage` gate's detail is the API's own sentence, already shown above. */}
        {phrase && technical && approval.detail && approval.detail !== phrase ? (
          <p data-approval-raw-detail="" className="mt-2 text-caption-1-regular text-text-tertiary wrap-anywhere">{approval.detail}</p>
        ) : null}

        {!phrase || technical ? (
        <div id={phrase ? `${commandId}-raw` : undefined} className="mt-3 min-w-0 max-w-full overflow-hidden rounded-lg border border-border-button-default bg-background-secondary-default">
          <div className="flex min-w-0 items-stretch">
          <div
            data-approval-command-scroll=""
            className={cn(
              "scrollbar-subtle min-w-0 max-w-full flex-1 overscroll-contain",
              dock || expanded ? "max-h-40 overflow-auto" : "overflow-x-auto",
            )}
          >
            <ol id={phrase ? undefined : commandId} className="w-max min-w-full py-2 font-mono text-[13px] leading-6 text-text-secondary">
              {visible.map((line, index) => (
                <li key={index} className="grid w-max min-w-full grid-cols-[2.25rem_max-content]">
                  <span
                    aria-hidden
                    className="sticky left-0 select-none bg-background-secondary-default pr-2 text-right tabular-nums text-text-tertiary"
                  >
                    {index + 1}
                  </span>
                  <span className="whitespace-pre pe-3">{line || " "}</span>
                </li>
              ))}
            </ol>
          </div>

          <button
            type="button"
            onClick={copy}
            aria-label={copied ? t("gateCard.copied") : t("gateCard.copy")}
            className="grid size-11 shrink-0 place-items-center self-start text-text-tertiary outline-none hover:bg-background-primary-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring fine:size-8"
          >
            {copied ? <Check aria-hidden className="size-3.5 text-pos-700" /> : <Copy aria-hidden className="size-3.5" />}
          </button>
          </div>

          {overflowing && !dock ? (
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={phrase ? `${commandId}-raw` : commandId}
              onClick={() => setExpanded(!expanded)}
              className="flex min-h-8 w-full items-center gap-2 border-t border-border-button-default px-3 py-1.5 text-left text-caption-1-regular text-text-tertiary outline-none hover:bg-background-primary-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring coarse:min-h-11"
            >
              <ChevronDown
                aria-hidden
                className={`size-3.5 shrink-0 transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`}
              />
              <span>
                {expanded
                  ? t("gateCard.collapse")
                  : plural(lines.length - COLLAPSED_LINES, {
                      one: t("gateCard.hidden_one"),
                      other: t("gateCard.hidden_other", { count: lines.length - COLLAPSED_LINES }),
                    })}
              </span>
            </button>
          ) : null}
        </div>
        ) : null}

        {decide.isError ? (
          <p role="alert" className="mt-2 text-body-regular text-destructive-text">{(decide.error as Error).message}</p>
        ) : null}

        {hidden ? (
          <p className="mt-2 text-caption-1-regular text-text-tertiary">{t("gateCard.mustExpand")}</p>
        ) : null}

        {always === "always_runtime_terminal" && live ? (
          <p id={`${commandId}-always-warning`} className="mt-3 text-caption-1-regular text-warn-700">
            {t("gateCard.alwaysRuntimeTerminalWarning")}
          </p>
        ) : null}

        {choices.length === 0 ? (
          <p className="mt-3 text-body-regular text-destructive-text">{t("gateCard.noChoices")}</p>
        ) : (
          <div className="mt-4 flex flex-wrap items-stretch gap-2">
            {choices.includes("deny") ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!live}
                aria-keyshortcuts="Escape"
                onClick={() => respond("deny")}
                className={actionClass}
              >
                {chosen === "deny" ? t("gateCard.deciding") : t("gateCard.deny")}
              </Button>
            ) : null}
            {always && choices.includes("once") ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!live}
                data-approval-always={always}
                aria-describedby={always === "always_runtime_terminal" ? `${commandId}-always-warning` : undefined}
                onClick={() => respond(always)}
                className={actionClass}
              >
                {chosen === always
                  ? t("gateCard.deciding")
                  : always === "always_bot_tool" ? t("gateCard.alwaysBotTool") : t("gateCard.alwaysRuntimeTerminal")}
              </Button>
            ) : null}
            {choices.includes("once") ? (
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={!live}
                title={hidden ? t("gateCard.mustExpand") : undefined}
                onClick={() => respond("once")}
                className={actionClass}
              >
                {chosen === "once" ? t("gateCard.deciding") : t("gateCard.allowOnce")}
              </Button>
            ) : null}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

/**
 * PERM2-7: why the auto review leaves the gate to the human. The reviewer's
 * reason is raw text rendered as such by React: never Markdown
 * nor HTML, it comes from a model.
 */
function reviewLine(review: ApprovalRequestDto["review"], t: ReturnType<typeof useT>["t"]): string | null {
  if (!review) return null;
  if (review.reason === "review_timeout") return t("gateCard.reviewTimeout");
  if (review.reason === "review_runtime_busy") return t("gateCard.reviewRuntimeBusy");
  if (review.reason === "review_circuit_open") return t("gateCard.reviewCircuitOpen");
  return review.note ? t("gateCard.reviewEscalated", { reason: review.note }) : t("gateCard.reviewEscalatedBare");
}

/**
 * A persistent decision at the edge of the composer. A single gate is handled at a
 * time, in the order the snapshot provides; the next one takes its place on
 * refetch. The timeline keeps a compact trace of the context in parallel.
 */
export function PendingApprovalDock({
  approvals,
  requester,
}: {
  approvals: readonly ApprovalRequestDto[];
  requester?: string;
}) {
  const pending = approvals.filter((approval) => approval.status === "pending");
  const current = pending[0];
  if (!current) return null;
  return (
    <div data-approval-dock="" className="min-w-0 max-w-full shrink-0 px-4 pt-2 sm:px-6">
      <GateCard
        key={current.id}
        approval={current}
        mode="dock"
        requester={requester}
        queue={{ index: 1, total: pending.length }}
      />
    </div>
  );
}
