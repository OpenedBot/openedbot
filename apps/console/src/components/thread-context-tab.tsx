import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Folder, X } from "lucide-react";
import type { ContextPreambleDto, RunDto } from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import { fallbackContextWindow } from "@openedbot/runtimes/domain/runtime/model-context-window";
import {
  contextUsageBreakdown,
  contextUsageTools,
  isContextUsageReading,
  type ContextUsageReading,
} from "@openedbot/runtimes/domain/runtime/context-usage";
import {
  AgentContextMeter,
  AgentLimitsCard,
  cn,
  Dialog,
  Skeleton,
  SkeletonRegion,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  type AgentBudgetGroup,
  type AgentBudgetSegment,
  type AgentPlanLimit,
  useCoarsePointer,
  useIsMobile,
} from "@openedbot/browser-ui-kit";
import { api, queryKeys, runtimesQueryOptions } from "../lib/api";
import { useT } from "../lib/i18n";
import {
  ProviderLimitsPanel,
  providerLimitsWorthShowing,
  resetLabel,
  useProviderLimits,
  type ProviderLimits,
} from "./dashboard/provider-limits-panel";
import { useSecondaryReadsReady } from "../lib/shell/after-first-paint";
import { canvasChromeButton, useAttachmentCanvas } from "./attachment-canvas";

/**
 * L'onglet de statut accroché au bord haut du composer, et son détail.
 *
 * Deux choses, et seulement celles-là : ce que le dernier tour a occupé de la
 * fenêtre de contexte, et où en sont les quotas du compte fournisseur. Le
 * premier est une mesure locale (`runs.usage`), le second vient de l'hôte
 * (`/hermes-setup/usage`). Aucun des deux n'est estimé ici.
 *
 * La fenêtre de contexte, elle, n'est PAS une mesure locale : le gateway
 * Hermes ne la publie nulle part. Un hôte qui sert `edge-setup` la donne
 * (`/hermes-setup/model-context`) ; sinon on retombe sur la table locale
 * `fallbackContextWindow`, et sans elle non plus on n'affiche aucun plafond.
 */

/** Ce que le dernier tour terminé a réellement mis dans la fenêtre. */
export type ThreadContextReading = {
  inputTokens: number;
  outputTokens: number;
  model: string | null;
};

/**
 * Le dernier run qui a rendu un usage. On remonte le fil : un run en vol n'a
 * pas encore d'usage, et un run échoué en a parfois un partiel qui ne décrit
 * plus l'état de la session.
 */
export function lastContextReading(runs: readonly RunDto[]): ThreadContextReading | null {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]!;
    if (run.status !== "completed" || !run.usage) continue;
    const inputTokens = Math.max(0, Math.floor(run.usage.inputTokens));
    const outputTokens = Math.max(0, Math.floor(run.usage.outputTokens));
    if (inputTokens + outputTokens <= 0) continue;
    // `run.model` est le modèle qui a exécuté CE tour, repli de fournisseur
    // compris. `runtimeSession` reste lu pour une API antérieure.
    return { inputTokens, outputTokens, model: nonEmpty(run.model) ?? nonEmpty(run.runtimeSession?.model) };
  }
  return null;
}

/**
 * Une chaîne vide n'est pas une valeur : l'hôte rend `model: ""` quand il ne
 * sait pas dire, et `??` la laisserait passer pour un nom de modèle. C'est ce
 * qui faisait tomber la fenêtre de contexte à « inconnue » alors que le fil
 * savait parfaitement sur quel modèle il tournait.
 */
export function nonEmpty(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

/**
 * Ce que le modèle avait en main au dernier tour, tel que le worker l'a mesuré
 * à la clôture. La dernière lecture gagne : les précédentes décrivent un tour
 * révolu.
 */
export function lastContextUsage(
  events: readonly StoredProductEvent[],
): ContextUsageReading | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const reading = events[index]!.payload.contextUsage;
    if (isContextUsageReading(reading)) return reading;
  }
  return null;
}

type Translate = ReturnType<typeof useT>["t"];

/**
 * La fenêtre, poste par poste, dans l'ordre de la carte BoardUI : ce qui
 * occupe vraiment d'abord, le préambule ensuite, puis ce qui est listé sans
 * être compté (MCP, non mesuré). Trois sources, chacune dite pour ce qu'elle
 * est :
 *
 *  - le tour, mesuré par le worker (`contextUsage`), poste par poste quand la
 *    lecture porte son détail, en deux blocs pour une lecture plus ancienne,
 *    et à défaut le dernier `usage` facturé ;
 *  - le préambule de Hermes (identité, mémoire, skills, schémas d'outils),
 *    mesuré sur l'hôte (`RuntimeModelContextDto.preamble`) ;
 *  - rien pour ce qui ne se mesure pas : un poste « non mesuré » se liste
 *    d'un tiret, il ne s'invente pas un chiffre.
 */
export function contextBudget({
  occupancy,
  reading,
  preamble,
  t,
}: {
  occupancy: ContextUsageReading | null;
  reading: ThreadContextReading;
  preamble: ContextPreambleDto | null;
  t: Translate;
}): { segments: AgentBudgetSegment[]; groups: AgentBudgetGroup[] } {
  const segments: AgentBudgetSegment[] = [];
  const groups: AgentBudgetGroup[] = [];
  const breakdown = occupancy ? contextUsageBreakdown(occupancy) : null;
  // Un poste à zéro n'est pas une information : il ne fait que rallonger la
  // liste. « Messages » reste, c'est le poste qui existe toujours.
  const counted = (label: string, value: number) => {
    if (value > 0) segments.push({ label, value });
  };

  if (breakdown) {
    segments.push({
      label: t("threadContext.segmentMessages"),
      value: breakdown.history + breakdown.input + breakdown.reply,
    });
    counted(t("threadContext.segmentToolResults"), breakdown.toolResults);
    counted(t("threadContext.segmentToolCalls"), breakdown.toolCalls);
    counted(t("threadContext.segmentReasoning"), breakdown.reasoning);
    counted(t("threadContext.segmentInstructions"), breakdown.instructions);
  } else if (occupancy) {
    segments.push(
      { label: t("threadContext.segmentConversation"), value: Math.max(0, occupancy.tokens - occupancy.toolTokens) },
      { label: t("threadContext.segmentToolResults"), value: occupancy.toolTokens },
    );
  } else {
    segments.push(
      { label: t("threadContext.segmentInput"), value: reading.inputTokens },
      { label: t("threadContext.segmentOutput"), value: reading.outputTokens },
    );
  }

  const tools = occupancy ? contextUsageTools(occupancy) : [];
  if (tools.length > 0) {
    groups.push({
      label: t("threadContext.groupTurnTools"),
      value: tools.reduce((sum, tool) => sum + tool.tokens, 0),
      items: tools.map((tool) => ({
        label: tool.name,
        value: tool.tokens,
        detail: tool.calls > 0
          ? t(tool.calls > 1 ? "threadContext.toolCallsMany" : "threadContext.toolCallsOne", { count: tool.calls })
          : undefined,
      })),
    });
  }

  if (!preamble) {
    // L'hôte ne mesure pas encore son préambule : il existe, on le dit, et la
    // barre n'en invente pas la taille.
    segments.push({ label: t("threadContext.segmentPreambleUnknown"), value: null, deferred: true });
    return { segments, groups };
  }

  const bucket = (key: ContextPreambleDto["buckets"][number]["key"]) =>
    preamble.buckets.find((candidate) => candidate.key === key) ?? null;
  const preambleSegment = (
    key: ContextPreambleDto["buckets"][number]["key"],
    label: string,
    unmeasuredLabel: string,
    groupLabel: string | null,
  ) => {
    const found = bucket(key);
    if (!found) return;
    if (found.tokens === null) segments.push({ label: unmeasuredLabel, value: null, deferred: true });
    else counted(label, found.tokens);
    if (groupLabel && found.items.length > 0) {
      groups.push({
        label: groupLabel,
        value: found.tokens,
        items: found.items.map((item) => ({ label: item.name, value: item.tokens })),
      });
    }
  };
  preambleSegment("tools", t("threadContext.segmentSystemTools"), t("threadContext.segmentSystemToolsUnmeasured"), t("threadContext.groupSystemTools"));
  preambleSegment("skills", t("threadContext.segmentSkills"), t("threadContext.segmentSkills"), t("threadContext.groupSkills"));
  preambleSegment("identity", t("threadContext.segmentIdentity"), t("threadContext.segmentIdentity"), null);
  preambleSegment("memory", t("threadContext.segmentMemory"), t("threadContext.segmentMemory"), t("threadContext.groupMemory"));
  preambleSegment("mcp", t("threadContext.segmentMcp"), t("threadContext.segmentMcp"), t("threadContext.groupMcp"));
  return { segments, groups };
}

/**
 * Les limites de forfait des fournisseurs EN SERVICE, une ligne par fenêtre
 * (5 h, semaine, ...), comme le bas de la carte BoardUI. Un compte branché
 * que rien n'utilise reste dans l'onglet Quotas : ce n'est pas le mur de ce fil.
 */
export function planLimits(limits: ProviderLimits, t: Translate): { label: string; rows: AgentPlanLimit[] } | null {
  const serviced = limits.providers
    .filter((provider) => limits.inService.has(provider.slug))
    .map((provider) => {
      const snapshot = limits.snapshots.get(provider.slug);
      const windows = (snapshot?.windows ?? []).filter((window) => window.usedPercent !== null);
      return { provider, plan: snapshot?.plan ?? null, windows };
    })
    .filter((entry) => entry.windows.length > 0);
  if (serviced.length === 0) return null;
  const single = serviced.length === 1 ? serviced[0]! : null;
  const rows = serviced.flatMap(({ provider, windows }) => windows.map((window, index): AgentPlanLimit => {
    const reset = resetLabel(window.resetAt, t);
    return {
      id: `${provider.slug}:${index}`,
      label: single ? window.label : `${provider.name} · ${window.label}`,
      used: (window.usedPercent ?? 0) / 100,
      resets: reset ? t("providerLimits.resetIn", { reset }) : null,
    };
  }));
  return {
    label: single
      ? t("threadContext.planLimits", { plan: single.plan ?? single.provider.name })
      : t("threadContext.planLimitsAll"),
    rows,
  };
}

/**
 * La fenêtre de contexte d'un modèle. Le runtime prime (lui seul connaît
 * l'override de config de son hôte), puis la table de l'amont, puis le
 * plafond dur que l'amont applique à un modèle inconnu. Partagé par le fil
 * d'un bot et par chaque membre d'un crew.
 */
export function resolveContextWindow(runtimeWindow: number, model: string | null): number {
  return runtimeWindow > 0 ? runtimeWindow : (fallbackContextWindow(model) ?? 0);
}

/**
 * La lecture de la fenêtre pour un profil Hermes. Elle ne bouge qu'au
 * changement de modèle : une lecture par (runtime, profil) suffit, et l'API la
 * garde un quart d'heure de son côté.
 */
export function modelContextQueryOptions(runtimeId: string | null, hermesProfile: string | null, enabled: boolean) {
  return {
    queryKey: queryKeys.runtimeModelContext(runtimeId ?? "none", hermesProfile),
    queryFn: () => api.runtimeModelContext(runtimeId!, hermesProfile),
    enabled: enabled && runtimeId !== null,
    staleTime: 10 * 60_000,
  };
}

/** Ce qu'un bot (un membre de crew) a occupé de sa fenêtre à son dernier tour. */
export type BotContextReading = {
  reading: ThreadContextReading;
  /** Le modèle du dernier tour terminé, repli de fournisseur compris. */
  model: string | null;
  window: number;
  /** Jetons comptés dans la fenêtre. */
  used: number;
  /** `null` quand la fenêtre est inconnue : on n'invente pas un pourcentage. */
  percent: number | null;
};

/**
 * La lecture d'UN bot dans un fil qui en réunit plusieurs (un crew) : on ne
 * garde que ses runs, et les événements de ces runs. Chaque membre a sa propre
 * session Hermes, donc son propre modèle et sa propre fenêtre. `null` tant
 * qu'il n'a aucun tour terminé qui ait rendu un usage.
 */
export function botContextReading({
  botId,
  runs,
  events = [],
  configuredModel,
  runtimeWindow,
  preamble = null,
  t,
}: {
  botId: string;
  runs: readonly RunDto[];
  events?: readonly StoredProductEvent[];
  /** Le modèle réglé du bot, sinon celui que l'hôte donne pour son profil. */
  configuredModel: string | null;
  runtimeWindow: number;
  preamble?: ContextPreambleDto | null;
  t: Translate;
}): BotContextReading | null {
  const botRuns = runs.filter((run) => run.botId === botId);
  const reading = lastContextReading(botRuns);
  if (!reading) return null;
  const runIds = new Set(botRuns.map((run) => run.id));
  const occupancy = lastContextUsage(events.filter((event) => runIds.has(event.runId)));
  const window = resolveContextWindow(runtimeWindow, reading.model ?? nonEmpty(configuredModel));
  const budget = contextBudget({ occupancy, reading, preamble, t });
  const used = budget.segments.reduce((sum, segment) => sum + (segment.deferred ? 0 : segment.value ?? 0), 0);
  return { reading, model: reading.model, window, used, percent: window > 0 ? Math.min(100, (used / window) * 100) : null };
}

export function ThreadContextTab({
  runs,
  events = [],
  botModel,
  hermesProfile,
  variant = "tab",
}: {
  runs: readonly RunDto[];
  /** Le fil, pour y relire l'occupation de session posée à la clôture d'un run. */
  events?: readonly StoredProductEvent[];
  /**
   * Le modèle du fil quand aucun tour n'a encore été mesuré : le réglage du
   * bot, sinon le défaut du runtime (`ThreadSnapshot.effectiveModel`). Un bot
   * qui hérite du runtime a `bots.model` vide, et passer ce vide ici privait
   * la fenêtre de contexte du seul nom de modèle disponible.
   */
  botModel: string | null;
  hermesProfile: string | null;
  /**
   * `tab` : la languette accrochée au bord haut du composer (bureau).
   * `inline` : une ligne de texte pour le sous-titre de l'en-tête mobile,
   * comme le « en ligne » sous un nom dans WhatsApp. Le composer reste une
   * pilule ; le détail s'ouvre dans le même dialogue.
   * `header` : la pastille de la barre du haut (bureau), un camembert et le
   * pourcentage, à côté du modèle.
   * `status` : l'anneau de 16 px et le pourcentage de la ligne sous le
   * composer (même dialogue, mêmes données que les autres variantes).
   */
  variant?: "tab" | "inline" | "header" | "status";
}) {
  const { t, formatNumber } = useT();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [tab, setTab] = useState<"context" | "quotas">("context");
  const isMobile = useIsMobile();
  const coarse = useCoarsePointer();
  /*
    Le détail s'ouvre dans le canva de droite, à côté du fil : c'est en lisant
    la conversation qu'on regarde ce qu'elle coûte, et une modale la cachait.
    Hors fournisseur de canva (tests, écran sans canva), le dialogue reste.
    `panelId` distingue les déclencheurs montés ensemble : seul celui qui a
    ouvert remplit l'emplacement.
  */
  const canvas = useAttachmentCanvas();
  const panelId = useId();
  const open = canvas ? canvas.panel?.id === panelId : dialogOpen;
  const canvasSlot = canvas?.panelSlot?.owner === panelId ? canvas.panelSlot.element : null;
  const reading = lastContextReading(runs);

  const auth = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const privileged = auth.data?.session.role === "owner" || auth.data?.session.role === "admin";
  const runtimes = useQuery({ ...runtimesQueryOptions(), enabled: privileged });
  const runtimeId = runtimes.data?.runtimes[0]?.id ?? null;
  const secondaryReady = useSecondaryReadsReady();
  const context = useQuery(modelContextQueryOptions(runtimeId, hermesProfile, privileged && secondaryReady));
  // Le relevé fournisseur est ici chez lui : c'est la surface unique du quota,
  // et le composer est l'endroit où l'on décide de dépenser. Le détail par bot
  // n'est lu qu'une fois le dialogue ouvert.
  const limits = useProviderLimits(open);
  // Le canva s'ouvre tout de suite ; tant que ses lectures arrivent, il montre
  // la silhouette du résultat. `isLoading` et non `isPending` : une requête
  // désactivée (pas de runtime, lecteur sans droit) reste `pending` à vie, et
  // la silhouette ne finirait jamais.
  const detailLoading = auth.isLoading
    || runtimes.isLoading
    || context.isLoading
    || (limits.pending && limits.busy);

  // Du plus précis au plus général : le modèle du tour mesuré, celui du fil,
  // puis ce que l'hôte dit de son modèle courant. Chaque étage est filtré du
  // vide, sinon un `""` de l'hôte gagnait contre un nom parfaitement connu.
  const model = reading?.model ?? nonEmpty(botModel) ?? nonEmpty(context.data?.model);
  const runtimeWindow = context.data?.status === "ok" ? context.data.contextWindow : 0;
  const window = resolveContextWindow(runtimeWindow, model);
  /*
    Deux grandeurs, et une seule remplit la fenêtre.

    `occupancy` : ce que le modèle avait EN MAIN au dernier tour, mesuré sur ce
    qui lui a été envoyé plus ce que le tour a fait pousser. Ce n'est ni la
    taille de la session (openedbot borne l'historique de chaque tour : mesuré, une
    session passée de 22 000 à 198 000 jetons pendant que l'envoi restait plat
    à 29 300) ni le coût.

    `turnCost` : ce que le tour a FACTURÉ. Dix appels d'outils paient dix
    prompts portant chacun tout le contexte : mesuré sur un fil réel, 143 223
    jetons facturés pour un contexte bien plus petit. Rapporté à la fenêtre, ce
    nombre dépasse 100 % sans que rien ne déborde. Il reste écrit, comme un coût.
  */
  const occupancy = lastContextUsage(events);
  const turnCost = reading ? reading.inputTokens + reading.outputTokens : 0;
  const preamble = context.data?.status === "ok" ? context.data.preamble ?? null : null;

  // Rien de mesuré : pas d'onglet. Une barre à zéro pour un fil qui n'a jamais
  // tourné dirait « il reste tout », alors qu'on ne sait rien.
  if (!reading) return null;

  // La pastille et la carte disent le même nombre : la somme des postes
  // comptés, préambule de l'hôte compris quand il est mesuré.
  const budget = contextBudget({ occupancy, reading, preamble, t });
  const used = budget.segments.reduce((sum, segment) => sum + (segment.deferred ? 0 : segment.value ?? 0), 0);
  const percent = window > 0 ? Math.min(100, (used / window) * 100) : 0;
  const plan = planLimits(limits, t);
  // Sans compte mesuré, l'onglet Quotas ne listerait que des « sans relevé » :
  // le dialogue se réduit alors au contexte, sans barre d'onglets.
  const showQuotas = providerLimitsWorthShowing(limits);
  const activeTab = showQuotas ? tab : "context";

  const readout = window > 0
    ? t("threadContext.readout", { used: formatNumber(used), window: formatNumber(window) })
    : t("threadContext.readoutUnbounded", { used: formatNumber(used) });

  const closeDetail = () => {
    if (canvas) canvas.close();
    else setDialogOpen(false);
  };
  // Rouvert, le détail reprend sur le fil qu'on regardait. Le déclencheur
  // referme le canva qu'il a lui-même ouvert, comme un interrupteur.
  const toggleDetail = () => {
    if (open) {
      closeDetail();
      return;
    }
    setTab("context");
    if (canvas) canvas.openPanel({ id: panelId, label: t("threadContext.title") });
    else setDialogOpen(true);
  };
  // Pendant la lecture, le titre complet : le relevé des quotas n'est pas
  // encore là pour dire s'il y aura deux onglets, et le titre ne doit pas
  // changer sous les yeux une fois les chiffres arrivés.
  const detailTitle = showQuotas || detailLoading ? t("threadContext.title") : t("threadContext.windowLabel");
  const detailDescription = showQuotas || detailLoading ? t("threadContext.description") : undefined;

  const contextBody = (
    <>
      <AgentLimitsCard
        defaultExpanded
        budget={window > 0 ? {
          label: t("threadContext.windowLabel"),
          readout,
          max: window,
          segments: budget.segments,
          groups: budget.groups,
          formatValue: (value) => formatNumber(value),
        } : null}
        // Le bas de la carte : les fenêtres du forfait en service. La
        // flèche ouvre le relevé complet (tous les comptes, relecture).
        limits={plan ? {
          ...plan,
          action: showQuotas ? { label: t("threadContext.planLimitsOpen"), onClick: () => setTab("quotas") } : undefined,
        } : null}
        formatPercent={(value) => t("threadContext.inline", {
          percent: formatNumber(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
        })}
        formatLimitPercent={(value) => t("providerLimits.usedPercentValue", { percent: Math.round(value) })}
        freeLabel={t("threadContext.free")}
        expandLabel={t("threadContext.expand")}
        collapseLabel={t("threadContext.collapse")}
      />
      {/* Le coût du dernier tour se lit à part : ce n'est pas une part
          de la fenêtre, c'est ce que l'appel a facturé. */}
      <p className="mt-3 text-xs leading-snug text-muted-foreground">
        {t("threadContext.turnCost", { tokens: formatNumber(turnCost) })}
      </p>
    </>
  );

  /* Deux sujets, deux onglets. Empilés, la ventilation du contexte et le
     relevé des abonnements se lisaient comme une seule liste de chiffres, et
     le quota d'un fournisseur passait pour une part de la fenêtre. Le contexte
     s'ouvre en premier : c'est le fil qu'on regardait. Sans compte mesuré, il
     n'y a qu'un sujet : le détail est le contexte. */
  const detailBody = showQuotas ? (
    <Tabs
      value={activeTab}
      onValueChange={(value) => setTab(value === "quotas" ? "quotas" : "context")}
      className="gap-3"
    >
      <TabsList className="w-full">
        <TabsTrigger value="context">{t("threadContext.tabContext")}</TabsTrigger>
        <TabsTrigger value="quotas">
          {t("threadContext.tabQuotas")}
          {/* Le pic en service, quand il y en a un : l'onglet dit ce qu'il
              contient sans qu'on ait à l'ouvrir. */}
          {limits.servicePeak !== null ? (
            <span className="rounded-full bg-muted-foreground/15 px-1.5 text-[11px] leading-4 tabular-nums">
              {t("providerLimits.usedPercentValue", { percent: Math.round(limits.servicePeak) })}
            </span>
          ) : null}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="context" className="flex flex-col">
        {contextBody}
      </TabsContent>

      <TabsContent value="quotas">
        <ProviderLimitsPanel limits={limits} onNavigate={closeDetail} />
      </TabsContent>
    </Tabs>
  ) : (
    <div className="flex flex-col">{contextBody}</div>
  );

  return (
    <>
      {variant === "header" ? (
        <button
          type="button"
          data-thread-context-header=""
          onClick={toggleDetail}
          aria-label={t("threadContext.open")}
          title={readout}
          className="inline-flex h-[30px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-body-2-medium text-text-secondary tabular-nums outline-none transition-colors hover:bg-background-secondary-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        >
          {/* Un camembert plein, pas un anneau : à côté du modèle, un arc fin se
              lisait comme un chargement. Plafond inconnu : le disque reste vide
              et c'est le compte de jetons qui s'écrit. */}
          <span
            aria-hidden
            className="size-3.5 shrink-0 rounded-full opacity-80 shadow-[inset_0_0_0_1.5px_currentColor]"
            style={{ background: `conic-gradient(currentColor ${window > 0 ? percent : 0}%, transparent 0)` }}
          />
          <span className="whitespace-nowrap">
            {window > 0
              ? t("threadContext.inline", { percent: formatNumber(Math.round(percent * 10) / 10) })
              : readout}
          </span>
        </button>
      ) : variant === "status" ? (
        <button
          type="button"
          data-thread-context-status=""
          onClick={toggleDetail}
          aria-label={t("threadContext.open")}
          title={readout}
          className="ohb-press -me-2 flex shrink-0 cursor-pointer items-center rounded-[40px] outline-none transition-colors duration-150 hover:bg-background-tertiary-default/60 focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        >
          {/* Plafond inconnu : la piste reste nue et le compte de jetons
              s'écrit, comme dans les autres variantes. */}
          <AgentContextMeter
            className="bg-transparent text-foreground-icon-secondary"
            textClassName="text-body-2-medium text-text-secondary"
            percent={window > 0 ? percent : null}
            readout={window > 0
              ? t("threadContext.inline", { percent: formatNumber(Math.round(percent * 10) / 10) })
              : readout}
            label={readout}
          />
        </button>
      ) : variant === "inline" ? (
        <button
          type="button"
          data-thread-context-inline=""
          onClick={toggleDetail}
          aria-label={t("threadContext.open")}
          title={readout}
          // Même survol que le sélecteur de modèle voisin (`ThreadModelPicker`) :
          // les deux contrôles du composer se lisent comme cliquables. La
          // hauteur et le rembourrage restent au bureau : en sous-titre de
          // l'en-tête mobile, le texte garde son alignement.
          className="ohb-press inline-flex shrink-0 cursor-pointer items-center rounded-xl text-[13px] leading-4 text-muted-foreground outline-none transition-colors duration-150 hover:bg-background-primary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring sm:h-8 sm:px-2"
        >
          <span className="truncate tabular-nums">
            {window > 0
              ? t("threadContext.inline", { percent: formatNumber(Math.round(percent * 10) / 10) })
              : readout}
          </span>
        </button>
      ) : (
      <>
      {/* L'onglet fait CORPS avec la coque : bordure sur trois côtés, et
          `-mb-px` pour que sa base recouvre le trait supérieur de la carte.
          C'est ce chevauchement d'un pixel qui le fait lire comme une
          languette du composer et non comme une étiquette qui flotte. */}
      <button
        type="button"
        data-thread-context-tab=""
        onClick={toggleDetail}
        aria-label={t("threadContext.open")}
        className="ohb-press -mb-px flex h-[34px] w-full min-w-0 items-center justify-between gap-3 rounded-t-[16px] bg-[#ebebeb] px-2 py-1 text-[13px] font-medium text-[#737373] outline-none transition-colors hover:bg-[#e3e3e3] focus-visible:ring-2 focus-visible:ring-ring md:cursor-pointer dark:bg-muted/60 dark:text-muted-foreground dark:hover:bg-muted"
      >
        {/* À gauche le profil qui exécute, à droite ce que le tour a coûté.
            Le MODÈLE n'est pas répété ici : le sélecteur du composer le porte
            déjà, deux lignes plus bas, et le dire deux fois n'apprend rien. */}
        <span className="flex min-w-0 items-center gap-3 pl-1.5">
          {hermesProfile ? (
            <span
              className="flex min-w-0 items-center gap-1"
              title={t("threadContext.profile", { profile: hermesProfile })}
            >
              <Folder className="size-4 shrink-0" aria-hidden />
              <span className="truncate">{hermesProfile}</span>
            </span>
          ) : null}
        </span>
        {/* Une seule pastille dans les deux cas. Plafond connu : l'anneau se
            remplit et le pourcentage s'écrit. Plafond inconnu : la piste reste
            nue et c'est le compte de jetons qui s'écrit, sans arc à zéro qui
            prétendrait qu'il reste tout. */}
        {/* La piste suit la couleur du texte : sur le gris de la languette,
            `--color-agent-track` s'effaçait et un arc à 10 % se lisait comme
            un spinner. Le pourcentage dit ce qu'il mesure, sans survol. */}
        <AgentContextMeter
          className="bg-transparent [&_circle:first-child]:stroke-current [&_circle:first-child]:[stroke-opacity:0.25]"
          percent={window > 0 ? percent : null}
          readout={window > 0
            ? t("threadContext.tabReadout", { percent: formatNumber(Math.round(percent * 10) / 10) })
            : readout}
          label={readout}
        />
      </button>
      </>
      )}

      {canvasSlot ? createPortal(
        <>
          <header
            className={cn(
              "flex shrink-0 items-start gap-2 border-b px-4",
              coarse ? "border-border/60 py-1.5" : "border-border py-3",
            )}
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <h2 className="truncate text-sm font-medium">{detailTitle}</h2>
              {detailDescription ? (
                <p className="text-xs leading-snug text-muted-foreground">{detailDescription}</p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={closeDetail}
              aria-label={t("common.close")}
              title={t("common.close")}
              className={canvasChromeButton(coarse)}
            >
              <X className="size-4" />
            </button>
          </header>
          <div
            className={cn(
              "scrollbar-subtle min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3",
              isMobile && "pb-[max(0.75rem,var(--ohb-safe-bottom))]",
            )}
          >
            {detailLoading ? <ThreadContextSkeleton label={t("common.loading")} /> : detailBody}
          </div>
        </>,
        canvasSlot,
      ) : null}

      {canvas ? null : (
        <Dialog
          open={dialogOpen}
          onClose={closeDetail}
          title={detailTitle}
          description={detailDescription}
          closeLabel={t("common.close")}
          className="max-w-lg"
        >
          {detailLoading ? <ThreadContextSkeleton label={t("common.loading")} /> : detailBody}
        </Dialog>
      )}
    </>
  );
}

/**
 * La silhouette du détail, à la géométrie du résultat : la barre d'onglets, la
 * carte de la fenêtre (titre, jauge, une ligne par poste), les limites du
 * forfait, puis les notes de bas de carte. Des hauteurs proches du vrai
 * contenu : rien ne saute quand les chiffres arrivent.
 */
function ThreadContextSkeleton({ label }: { label: string }) {
  return (
    <SkeletonRegion label={label} className="flex flex-col gap-3" data-thread-context-skeleton="">
      <Skeleton className="h-9 w-full rounded-lg" />
      <div className="flex flex-col gap-3 rounded-2xl bg-card p-4 [--skeleton:var(--muted)] dark:[--skeleton:#404040]">
        <div className="flex items-center justify-between gap-4">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-1/4" />
        </div>
        <Skeleton className="h-1.5 w-full rounded-full" />
        <div className="flex flex-col gap-2.5 pt-1">
          {SKELETON_ROWS.map((width, index) => (
            <div key={index} className="flex items-center gap-2">
              <Skeleton className="size-2 shrink-0 rounded-full" />
              <Skeleton className="h-3.5" style={{ width }} />
              <Skeleton className="ms-auto h-3.5 w-12" />
              <Skeleton className="h-3.5 w-10" />
            </div>
          ))}
        </div>
        <div className="mt-1 flex flex-col gap-2.5 border-t border-border pt-4">
          <Skeleton className="h-4 w-2/5" />
          <div className="flex items-center justify-between gap-4">
            <Skeleton className="h-4 w-1/5" />
            <Skeleton className="h-3.5 w-1/4" />
          </div>
          <Skeleton className="h-1.5 w-full rounded-full" />
        </div>
      </div>
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-2/3" />
    </SkeletonRegion>
  );
}

/** Une largeur par poste de la fenêtre, irrégulière comme les vrais libellés. */
const SKELETON_ROWS = ["42%", "50%", "38%", "34%", "46%", "40%", "24%", "36%", "20%"];
