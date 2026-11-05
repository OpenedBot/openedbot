import { useState, type ReactNode } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Loader2, TriangleAlert } from "lucide-react";
import {
  canOperateWorkspace,
  ROOM_COMPACT_MIN_CHARS,
  type BotDto,
  type BotFaceSpec,
  type RunDto,
  type ThreadCompactionDto,
  type ThreadMessageDto,
} from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import { Button, Dialog, toast } from "@openedbot/browser-ui-kit";
import { api, ApiError, queryKeys, runtimesQueryOptions } from "../lib/api";
import { useT } from "../lib/i18n";
import { modelUnavailableByBot, type ModelUnavailableState } from "../lib/run/model-unavailable";
import { BotFace } from "./bot-face";
import {
  botContextReading,
  modelContextQueryOptions,
  nonEmpty,
  type BotContextReading,
} from "./thread-context-tab";

/**
 * La pastille de contexte d'un crew, et la liste de ses membres.
 *
 * Un crew n'a pas UNE jauge : chaque membre tourne dans sa propre session
 * Hermes, avec son modèle et sa fenêtre. La pastille montre donc le membre le
 * plus proche de sa limite (celui qui va casser en premier), et le dialogue
 * donne chaque membre, modèle compris. Même règle que `ThreadContextTab` : on
 * ne montre que ce qui a été mesuré, et sans fenêtre connue ce sont les jetons
 * qui s'écrivent, sans pourcentage.
 */

export type GroupContextMember = { id: string; name: string; face: BotFaceSpec | null };

/** Ce que la ligne d'un membre sait de lui, déjà résolu par `GroupContextTab`. */
export type GroupMemberContext = {
  member: GroupContextMember;
  /** Le modèle réglé du bot, sinon celui que l'hôte donne pour son profil. */
  configuredModel: string | null;
  /** `null` : aucun tour terminé n'a rendu d'usage pour ce membre. */
  reading: BotContextReading | null;
  /**
   * Le fournisseur refuse le modèle de ce membre (son dernier tour terminé est
   * cet échec) : l'alerte reste jusqu'à un tour réussi.
   */
  modelUnavailable?: ModelUnavailableState | null;
};

/**
 * Le membre le plus proche de sa limite : le pourcentage le plus haut, puis,
 * entre deux fenêtres inconnues, le plus de jetons. Un pourcentage connu
 * l'emporte sur un compte brut, qui ne se compare à rien. `null` si personne
 * n'a de mesure.
 */
export function busiestMember(members: readonly GroupMemberContext[]): (GroupMemberContext & { reading: BotContextReading }) | null {
  let best: (GroupMemberContext & { reading: BotContextReading }) | null = null;
  for (const entry of members) {
    if (!entry.reading) continue;
    const candidate = entry as GroupMemberContext & { reading: BotContextReading };
    if (!best) {
      best = candidate;
      continue;
    }
    const a = candidate.reading;
    const b = best.reading;
    const better = a.percent !== null && b.percent !== null
      ? a.percent > b.percent
      : (a.percent !== null) !== (b.percent !== null)
        ? a.percent !== null
        : a.used > b.used;
    if (better) best = candidate;
  }
  return best;
}

/**
 * Le modèle d'un dernier tour qui n'est pas celui réglé sur le bot : le
 * fournisseur a basculé sur un repli. Sans modèle réglé connu, on ne peut pas
 * dire qu'il y a repli.
 */
export function isFallbackModel(reading: BotContextReading | null, configuredModel: string | null): boolean {
  const ran = nonEmpty(reading?.model);
  const configured = nonEmpty(configuredModel);
  return ran !== null && configured !== null && ran !== configured;
}

/**
 * Une ligne du dialogue. `status` (sous le modèle) et `actions` (à droite, à
 * côté de « Changer le modèle ») sont des emplacements : l'état « modèle
 * indisponible » et le bouton de compression s'y logent sans toucher à la
 * ligne.
 */
export function GroupMemberContextRow({
  entry,
  status,
  actions,
  onNavigate,
}: {
  entry: GroupMemberContext;
  status?: ReactNode;
  actions?: ReactNode;
  /** Appelé quand un lien de la ligne quitte le dialogue. */
  onNavigate?: () => void;
}) {
  const { t, formatNumber } = useT();
  const { member, reading, configuredModel } = entry;
  const model = nonEmpty(reading?.model) ?? nonEmpty(configuredModel);
  const fallback = isFallbackModel(reading, configuredModel);
  const percent = reading?.percent ?? null;

  return (
    <li data-group-member-context={member.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-center gap-2.5">
        <BotFace name={member.name} seed={member.id} face={member.face} className="size-7 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{member.name}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {model ? <span className="truncate">{model}</span> : null}
            {fallback ? (
              <span className="shrink-0 rounded-full bg-muted-foreground/15 px-1.5 text-[11px] leading-4">
                {t("threadContext.groupFallback")}
              </span>
            ) : null}
          </span>
        </div>
        {actions}
        <Link
          to="/bot/$botId"
          params={{ botId: member.id }}
          onClick={onNavigate}
          className="shrink-0 text-xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("threadContext.groupChangeModel")}
        </Link>
      </div>
      {status}
      {reading ? (
        <div className="flex flex-col gap-1">
          {percent !== null ? (
            <div
              role="progressbar"
              aria-label={member.name}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(percent)}
              className="h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <div className="h-full rounded-full bg-foreground/70" style={{ width: `${percent}%` }} />
            </div>
          ) : null}
          <span className="text-xs tabular-nums text-muted-foreground">
            {reading.window > 0
              ? `${t("threadContext.readout", { used: formatNumber(reading.used), window: formatNumber(reading.window) })} · ${t("threadContext.inline", { percent: formatNumber(Math.round((percent ?? 0) * 10) / 10) })}`
              : t("threadContext.readoutUnbounded", { used: formatNumber(reading.used) })}
          </span>
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">{t("threadContext.groupNoMeasure")}</span>
      )}
    </li>
  );
}

/** L'état « modèle indisponible » d'un membre, sous la ligne de son modèle. */
function ModelUnavailableStatus({ state }: { state: ModelUnavailableState }) {
  const { t } = useT();
  return (
    <span role="alert" data-model-unavailable="" className="flex items-center gap-1.5 text-xs font-medium text-destructive">
      <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
      {state.model
        ? t("threadContext.groupModelUnavailable", { model: state.model })
        : t("threadContext.groupModelUnavailableNoModel")}
    </span>
  );
}

/** Statuts d'un run encore vivant : le serveur refuse de résumer tant qu'il en reste un. */
const LIVE_RUN_STATUSES = new Set(["queued", "starting", "running", "awaiting_approval"]);

/**
 * Caractères de texte du salon que le résumé n'a pas encore couverts. Les
 * messages portent leur séquence (`ThreadMessageDto.sequence`) ; sans elle, on
 * les compte tous. Une estimation : le serveur reste l'autorité (422).
 */
export function pendingCompactionChars(
  messages: readonly ThreadMessageDto[],
  compaction: ThreadCompactionDto | null | undefined,
): number {
  const watermark = compaction?.compactedThroughSequence ?? -1;
  let total = 0;
  for (const message of messages) {
    if (message.sequence !== undefined && Number(message.sequence) <= watermark) continue;
    for (const part of message.content) {
      if (part.type === "text") total += part.text.length;
    }
  }
  return total;
}

/**
 * Le geste « Compacter l'historique du salon » : une action sur le fil entier
 * (la compaction est par fil, pas par membre), donc sous la liste et pas sur
 * une ligne. Réservé à ceux qui opèrent le workspace, comme la route.
 */
function CompactRoomHistory({
  threadId,
  messages,
  compaction,
  busy,
}: {
  threadId: string;
  messages: readonly ThreadMessageDto[];
  compaction: ThreadCompactionDto | null | undefined;
  /** Un membre répond encore : le serveur répondrait 409. */
  busy: boolean;
}) {
  const { t, formatDate, plural } = useT();
  const queryClient = useQueryClient();
  const compact = useMutation({
    mutationFn: () => api.compactThread(threadId),
    onSuccess: (result) => {
      toast.success(plural(result.summarizedCount, {
        one: t("threadContext.compactDone_one", { count: result.summarizedCount }),
        other: t("threadContext.compactDone_other", { count: result.summarizedCount }),
      }));
      void queryClient.invalidateQueries({ queryKey: queryKeys.thread(threadId) });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError && error.message ? error.message : t("threadContext.compactFailed"));
      // Un 409 « tour en cours » ou un résumé déjà fait ailleurs : le fil a bougé.
      void queryClient.invalidateQueries({ queryKey: queryKeys.thread(threadId) });
    },
  });

  const tooShort = pendingCompactionChars(messages, compaction) < ROOM_COMPACT_MIN_CHARS;
  const reason = compact.isPending
    ? t("threadContext.compactRunning")
    : busy
      ? t("threadContext.compactBusy")
      : tooShort
        ? t("threadContext.compactTooShort")
        : t("threadContext.compactHint");

  return (
    <div data-group-compact="" className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
      {compaction ? (
        <span data-group-compacted-until="" className="text-xs text-muted-foreground">
          {t("threadContext.compactedUntil", { date: formatDate(compaction.compactedAt, { dateStyle: "medium", timeStyle: "short" }) })}
        </span>
      ) : null}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={compact.isPending || busy || tooShort}
          aria-busy={compact.isPending}
          aria-describedby={`compact-reason-${threadId}`}
          onClick={() => compact.mutate()}
        >
          {compact.isPending ? <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : null}
          {t("threadContext.compactButton")}
        </Button>
        <span id={`compact-reason-${threadId}`} className="min-w-0 text-xs text-muted-foreground">{reason}</span>
      </div>
    </div>
  );
}

export function GroupContextTab({
  members,
  bots,
  runs,
  events = [],
  variant = "header",
  threadId,
  messages = [],
  compaction,
}: {
  members: readonly GroupContextMember[];
  /** Le roster : le modèle réglé et le profil Hermes de chaque membre. */
  bots: readonly Pick<BotDto, "id" | "model" | "hermesProfile">[];
  runs: readonly RunDto[];
  events?: readonly StoredProductEvent[];
  /**
   * `header` : la pastille de la barre du haut (bureau). `inline` : une ligne
   * de texte pour le sous-titre de l'en-tête mobile. Le détail s'ouvre dans le
   * même dialogue.
   */
  variant?: "header" | "inline";
  /** Le fil du salon : sans lui, le dialogue ne propose pas de compacter. */
  threadId?: string;
  /** Les messages chargés du fil, pour estimer ce qu'il reste à résumer. */
  messages?: readonly ThreadMessageDto[];
  /** Jusqu'où le salon est déjà résumé (`ThreadSnapshot.compaction`). */
  compaction?: ThreadCompactionDto | null;
}) {
  const { t, formatNumber, formatDate } = useT();
  const [open, setOpen] = useState(false);

  const auth = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const privileged = auth.data?.session.role === "owner" || auth.data?.session.role === "admin";
  // La route exige `requireOperator` : owner, admin et agence.
  const canCompact = canOperateWorkspace(auth.data?.session.role ?? "");
  const runtimes = useQuery({ ...runtimesQueryOptions(), enabled: privileged });
  const runtimeId = runtimes.data?.runtimes[0]?.id ?? null;
  // Une fenêtre par membre (son profil Hermes, son modèle). React Query
  // dédouble les profils identiques : quelques lectures au plus.
  const profiles = members.map((member) => bots.find((bot) => bot.id === member.id)?.hermesProfile ?? null);
  const contexts = useQueries({
    queries: profiles.map((profile) => modelContextQueryOptions(runtimeId, profile, privileged)),
  });

  const unavailable = modelUnavailableByBot(runs);
  const entries: GroupMemberContext[] = members.map((member, index) => {
    const bot = bots.find((candidate) => candidate.id === member.id);
    const context = contexts[index]?.data;
    const configuredModel = nonEmpty(bot?.model) ?? nonEmpty(context?.model);
    return {
      member,
      configuredModel,
      modelUnavailable: unavailable.get(member.id) ?? null,
      reading: botContextReading({
        botId: member.id,
        runs,
        events,
        configuredModel,
        runtimeWindow: context?.status === "ok" ? context.contextWindow : 0,
        preamble: context?.status === "ok" ? context.preamble ?? null : null,
        t,
      }),
    };
  });

  // Un modèle refusé passe avant toute jauge : ce membre ne répond plus du
  // tout, même sans aucune mesure. Sinon, aucun membre mesuré : pas de
  // pastille (une jauge à zéro dirait « il reste tout » d'un crew dont on ne
  // sait rien).
  const alerted = entries.find((entry) => entry.modelUnavailable) ?? null;
  const busiest = alerted ?? busiestMember(entries);
  if (!busiest) return null;

  const { reading } = busiest;
  const percent = reading?.percent ?? null;
  const readout = !reading
    ? ""
    : reading.window > 0
      ? t("threadContext.readout", { used: formatNumber(reading.used), window: formatNumber(reading.window) })
      : t("threadContext.readoutUnbounded", { used: formatNumber(reading.used) });
  const alertLabel = alerted?.modelUnavailable
    ? alerted.modelUnavailable.model
      ? t("threadContext.groupModelUnavailable", { model: alerted.modelUnavailable.model })
      : t("threadContext.groupModelUnavailableNoModel")
    : null;
  const label = alertLabel ?? (percent !== null
    ? t("threadContext.inline", { percent: formatNumber(Math.round(percent * 10) / 10) })
    : readout);
  const title = `${busiest.member.name} · ${alertLabel ?? readout}`;

  return (
    <>
      {variant === "header" ? (
        <button
          type="button"
          data-group-context-header=""
          onClick={() => setOpen(true)}
          aria-label={t("threadContext.groupOpen")}
          data-alert={alertLabel ? "model-unavailable" : undefined}
          title={title}
          className={`inline-flex h-[30px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-body-2-medium tabular-nums outline-none transition-colors hover:bg-background-secondary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring ${alertLabel ? "text-destructive" : "text-text-secondary hover:text-text-primary"}`}
        >
          <BotFace name={busiest.member.name} seed={busiest.member.id} face={busiest.member.face} className="size-4" />
          {/* Même camembert que `ThreadContextTab` : plafond inconnu, le disque
              reste vide et ce sont les jetons qui s'écrivent. */}
          {alertLabel ? (
            <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
          ) : (
            <span
              aria-hidden
              className="size-3.5 shrink-0 rounded-full opacity-80 shadow-[inset_0_0_0_1.5px_currentColor]"
              style={{ background: `conic-gradient(currentColor ${percent ?? 0}%, transparent 0)` }}
            />
          )}
          <span className="whitespace-nowrap">{label}</span>
        </button>
      ) : (
        <button
          type="button"
          data-group-context-inline=""
          onClick={() => setOpen(true)}
          aria-label={t("threadContext.groupOpen")}
          data-alert={alertLabel ? "model-unavailable" : undefined}
          title={title}
          className={`openedbot-press inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl text-[13px] leading-4 ${alertLabel ? "text-destructive" : "text-muted-foreground"} outline-none transition-colors duration-150 hover:bg-background-primary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring`}
        >
          <BotFace name={busiest.member.name} seed={busiest.member.id} face={busiest.member.face} className="size-4" />
          <span className="truncate tabular-nums">{label}</span>
        </button>
      )}

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("threadContext.groupTitle")}
        description={t("threadContext.groupDescription")}
        closeLabel={t("common.close")}
        className="max-w-lg"
      >
        <ul className="flex flex-col divide-y divide-border">
          {entries.map((entry) => (
            <GroupMemberContextRow
              key={entry.member.id}
              entry={entry}
              status={entry.modelUnavailable ? <ModelUnavailableStatus state={entry.modelUnavailable} /> : undefined}
              onNavigate={() => setOpen(false)}
            />
          ))}
        </ul>
        {threadId !== undefined && canCompact ? (
          <CompactRoomHistory
            threadId={threadId}
            messages={messages}
            compaction={compaction}
            busy={runs.some((candidate) => LIVE_RUN_STATUSES.has(candidate.status))}
          />
        ) : compaction ? (
          // Pas le droit de compacter, mais l'état du résumé reste lisible.
          <p data-group-compacted-until="" className="mt-4 text-xs text-muted-foreground">
            {t("threadContext.compactedUntil", { date: formatDate(compaction.compactedAt, { dateStyle: "medium", timeStyle: "short" }) })}
          </p>
        ) : null}
      </Dialog>
    </>
  );
}
