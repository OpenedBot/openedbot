import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Copy, ShieldAlert } from "lucide-react";
import type { ApprovalAlwaysChoice, ApprovalRequestDto } from "@openedbot/contracts-api";
import { Button, cn, toast } from "@openedbot/browser-ui-kit";
import { api, queryKeys } from "../lib/api";
import { gatePhrase } from "../lib/runtime/gate-phrase";
import { useT } from "../lib/i18n";

type GateChoice = "once" | "deny" | ApprovalAlwaysChoice;

/** Au-delà, la commande est repliée : une gate ne doit pas noyer le fil. */
const COLLAPSED_LINES = 5;

/**
 * La demande d'autorisation possède deux représentations coordonnées : une
 * trace dans le fil et, tant qu'elle est ouverte, une décision au bord du
 * composer. `inline` reste disponible pour les surfaces autonomes.
 *
 * C'est la pièce centrale du permission broker : aucune action risquée ne part
 * sans une décision prise pour elle.
 *
 * Le dessin est celui d'une notification BoardUI (carte 16 px, icône ronde,
 * titre 14/20 medium, corps 14/20, actions secondary puis primary) et du menu
 * Permission (une ligne pour ce qu'on demande, une ligne tronquée pour qui
 * demande). La commande défile dans la carte : elle ne pousse pas la page.
 *
 * Deux boutons, plus un troisième quand le serveur l'offre. Hermes en accepte
 * quatre, mais ses `session` et `always` accordent une permission que l'hôte
 * garde sans openedbot : ils restent refusés par l'API et la base. Le « Toujours »
 * d'openedbot (PERM2-4) est autre chose : un grant de cet outil sur ce bot, ou
 * l'interrupteur terminal du runtime, révocables dans les réglages ; Hermes
 * reçoit `once`. Le serveur décide s'il est offert (`alwaysOffered`) et le
 * recalcule au clic. La voix ne l'offre jamais.
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
   * Une demande issue d'un `tool.call` vit dans la même carte que l'outil.
   * En mode `summary`, elle ne duplique jamais les contrôles du dock.
   */
  embedded?: boolean;
  /** La timeline conserve la trace ; le dock près du composer porte la décision. */
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
    // Un refus du serveur change l'état de la gate aussi sûrement qu'un
    // succès (mesuré le 18-08-2026) : sur 409 `APPROVAL_REQUEST_EXPIRED`, le
    // fil gardait sa liste `approvals` du cache (le SSE ne la porte pas, voir
    // `use-thread-stream.ts`), donc le composeur restait désactivé sur « Une
    // décision est en attente ci-dessus… » alors que le serveur n'avait plus
    // aucune demande ouverte. Recharger est le seul geste qui rende au client
    // ce que le serveur sait déjà.
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

  // Gate identifiée : la phrase de la console remplace le texte du plugin
  // hôte (anglais). Le texte brut reste dans un détail replié.
  const phrase = gatePhrase(approval, t);
  const lines = approval.action.split("\n");
  const overflowing = lines.length > COLLAPSED_LINES;
  // Le dock est l'endroit où l'opérateur tranche : il ne masque jamais une
  // partie de la commande. Les longues actions défilent dans leur cadre.
  const visible = dock ? lines : overflowing && !expanded ? lines.slice(0, COLLAPSED_LINES) : lines;
  // Les deux boutons restent cliquables même si des lignes sont encore
  // masquées : un `ask_user` derrière une gate ne doit jamais rester bloqué
  // parce que la carte n'a pas fini de se déplier. `hidden` ne sert plus
  // qu'à l'indication visuelle en bas de carte.
  const hidden = !phrase && !dock && overflowing && !expanded;

  // AUCUNE frappe unique n'autorise. Une gate n'est pas un `ask_user` : on y
  // accorde l'exécution d'une commande, pas une réponse. Un badge « 1 » comme
  // dans `AskUserCard` suffisait à accorder une permission jamais lue : le
  // composeur se désactive à l'arrivée de la gate, le focus retombe sur
  // `body`, et un « 1 » destiné à une liste partait en approbation. Il reste
  // le Tab natif, ↵ sur le bouton focalisé, et Échap qui REFUSE, la seule
  // direction où une frappe accidentelle ne coûte qu'une redemande.
  const card = useRef<HTMLDivElement | null>(null);

  // Le focus ne se prend que si cette carte est la SEULE gate ouverte : à
  // plusieurs, c'est la première de l'arbre qui l'aurait volé alors que le fil
  // montre la dernière, et Échap aurait refusé une demande hors écran.
  useEffect(() => {
    if (!live || !hasDecision) return;
    const node = card.current;
    if (!node || document.querySelectorAll("[data-approval-decision]").length > 1) return;
    const active = document.activeElement;
    if (active && active !== document.body && !node.contains(active)) return;
    node.focus({ preventScroll: true });
  }, [hasDecision, live]);

  // Un verrou synchrone : `isPending` n'existe qu'au rendu suivant, deux
  // activations rapprochées (Échap pendant que le clic part) envoyaient deux
  // décisions dont seule la première était retenue par le serveur.
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

  // Dans le fil, la demande tient en UNE rangée de la trace du tour. La
  // commande entière et la décision vivent dans le dock près du composer :
  // deux cartes complètes répétaient la même commande l'une sous l'autre.
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
  // Notification BoardUI : secondary h-8 au pointeur fin, 44 px au doigt.
  // `flex-basis` 9rem : une rangée tant que les deux tiennent, sinon pile
  // pleine largeur, Allow once en dernier.
  const actionClass = "min-h-11 flex-[1_1_9rem] px-3 fine:h-8 fine:min-h-8 fine:w-auto fine:flex-none";

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
          ? "w-full overflow-hidden rounded-2xl border border-border-button-default bg-background-primary-default shadow-dropdown"
          : embedded
            ? "overflow-hidden border-t border-border-button-default"
            : "animate-agent-card-in my-3 w-full max-w-[85%] self-start overflow-hidden rounded-2xl border border-border-button-default bg-background-primary-default shadow-dropdown",
      )}
    >
      <div className={embedded && !dock ? "px-4 py-3" : "p-4"}>
        <div className="flex min-w-0 items-start gap-3">
          <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-full bg-info-100 text-info-700">
            <ShieldAlert className="size-5" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex min-w-0 items-center gap-2">
              <p className="min-w-0 truncate text-body-medium text-text-primary">{asked}</p>
              {queue && queue.total > 1 ? (
                <span className="shrink-0 rounded-full bg-background-tertiary-default px-2 py-0.5 text-caption-1-medium tabular-nums text-text-tertiary">
                  {t("gateCard.queue", { index: queue.index, total: queue.total })}
                </span>
              ) : null}
            </div>
            {requester ? (
              <p className="truncate text-body-regular text-text-tertiary" title={requester}>{requester}</p>
            ) : null}
          </div>
        </div>

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

        {phrase && technical && approval.detail ? (
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
  );
}

/**
 * PERM2-7 : pourquoi la revue auto laisse la gate à l'humain. Le motif du
 * réviseur est un texte brut rendu comme tel par React : jamais de Markdown
 * ni de HTML, il vient d'un modèle.
 */
function reviewLine(review: ApprovalRequestDto["review"], t: ReturnType<typeof useT>["t"]): string | null {
  if (!review) return null;
  if (review.reason === "review_timeout") return t("gateCard.reviewTimeout");
  if (review.reason === "review_runtime_busy") return t("gateCard.reviewRuntimeBusy");
  if (review.reason === "review_circuit_open") return t("gateCard.reviewCircuitOpen");
  return review.note ? t("gateCard.reviewEscalated", { reason: review.note }) : t("gateCard.reviewEscalatedBare");
}

/**
 * Décision persistante au bord du composer. Une seule gate est traitée à la
 * fois, dans l'ordre fourni par le snapshot ; la suivante prend sa place au
 * refetch. La timeline garde parallèlement une trace compacte du contexte.
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
