import { EnrollmentStep } from "../../../../components/runtime-command";
import {
  DIRECT_DIALOG_WIDTH,
  RuntimeDirectWizard,
  RuntimeDirectActions,
  RuntimeDirectStatus,
  RuntimePendingExposures,
  RuntimeReachabilityPicker,
} from "../../../../components/runtime-direct";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconDots, IconRefresh, IconServer2, IconServerBolt, IconTerminal2, IconTrash } from "@tabler/icons-react";
import {
  cn,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Label,
  Skeleton,
  toast,
} from "@openedbot/browser-ui-kit";
import { Link } from "@tanstack/react-router";
import { api, errorMessage, queryKeys } from "../../../../lib/api";
import { displayedRuntimeHealth } from "../../../../lib/runtime/runtime-health";
import { linkKind, useDeployEnvironment } from "../../../../lib/platform/deploy-environment";
import { useT } from "../../../../lib/i18n";
import { isLocalEngine, LOCAL_ENGINES, type RuntimeEnrollmentTicketDto, type RuntimePublicDto } from "@openedbot/contracts-api";
import {
  ACTIONS,
  BUTTON,
  CardHeading,
  EmptyState,
  Note,
  SettingsCard,
  ToneBadge,
} from "../../../../components/settings/primitives";
import { nativeBridge } from "../../../../lib/platform";
import { HEALTH_LABEL, RUNTIME_REFETCH_MS, invalidateRuntimeQueries } from "./cloud-shared";
import { ProviderIcon } from "../../../../components/provider-icon";
import { BUI_MENU_ITEM, BUI_POPOVER } from "../../../../components/boardui/menu";
import {
  EDGE_SETUP_INSTALL_STEPS,
  ENROLLMENT_DIALOG_WIDTH,
  RuntimeEnrollmentDialog,
} from "./cloud-enrollment";

/**
 * A runtime's removal: the button, and its confirmation when it serves the
 * runs.
 *
 * It lives in the TWO places where one looks at a runtime: the screen's « Runtime
 * actif » card and the waiting replacement's card.
 *
 * The active one goes through a modal because it is the only one whose removal cuts
 * the runs; a waiting replacement serves nothing, so the second gesture
 * would be noise.
 */
function useRuntimeRemove(runtime: RuntimePublicDto, onDone: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (confirm: boolean) => {
      if (!runtime.id) throw new Error("runtime");
      return api.deleteRuntime(runtime.id, confirm);
    },
    onSuccess: async () => {
      onDone();
      toast.success(`${runtime.name ?? "La machine"} est retirée.`);
      await invalidateRuntimeQueries(queryClient);
    },
    onError: (error) => toast.error(errorMessage(error, "Le retrait de la machine a échoué.")),
  });
}

/** The confirmation of a removal that cuts runs or bots: the active runtime, or a machine of agents. */
function RuntimeRemovalDialog({ runtime, open, onClose }: { runtime: RuntimePublicDto; open: boolean; onClose: () => void }) {
  const { t } = useT();
  const remove = useRuntimeRemove(runtime, onClose);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Retirer ${runtime.name} ?`}
      description={runtime.dedicated
        ? "Les bots affectés à cet agent ne pourront plus y exécuter de demandes."
        : "Cette machine sert les runs. Une fois retirée, plus rien ne les sert tant qu’une autre n’est pas appairée. Pour changer de machine, préférez Remplacer : il n’y a pas de trou."}
      role="alertdialog"
      closeLabel={t("common.close")}
    >
      <div className="space-y-4">
        <Note tone="warning" role="alert">
          Les runs en cours s’arrêtent et le lien est fermé tout de suite. Il faudra réappairer pour le reconnecter.
        </Note>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={BUTTON.secondary} disabled={remove.isPending} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className={BUTTON.danger} disabled={remove.isPending} onClick={() => remove.mutate(true)}>
            Retirer quand même
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * A waiting replacement's removal: it serves nothing, so it goes at once; the
 * active runtime and a machine of agents ask first.
 */
export function RuntimeRemoval({
  runtime,
  disabled,
  className,
}: {
  runtime: RuntimePublicDto;
  disabled?: boolean;
  className?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const remove = useRuntimeRemove(runtime, () => setConfirming(false));
  return (
    <>
      <button
        type="button"
        className={cn(BUTTON.danger, className)}
        disabled={disabled || remove.isPending || !runtime.id}
        onClick={() => (runtime.isActive || runtime.dedicated ? setConfirming(true) : remove.mutate(false))}
        aria-label={`Retirer ${runtime.name}`}
      >
        Retirer
      </button>
      <RuntimeRemovalDialog runtime={runtime} open={confirming} onClose={() => setConfirming(false)} />
    </>
  );
}

/** The « … » of a machine or an agent: the rare gestures, out of the way of the list. */
function MachineMenu({ runtime, label, disabled, onRelaunch }: {
  runtime: RuntimePublicDto;
  label: string;
  disabled?: boolean;
  /** Opens a new machine ticket: `edge-setup connect` re-pairs and restarts the agents. */
  onRelaunch?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={cn(BUTTON.small, "size-8 px-0")} disabled={disabled} aria-label={`Actions : ${label}`}>
            <IconDots className="size-4" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={cn(BUI_POPOVER, "min-w-[200px] gap-1")}>
          {onRelaunch ? (
            <DropdownMenuItem className={BUI_MENU_ITEM} onSelect={onRelaunch}>
              <IconRefresh className="size-4 shrink-0" aria-hidden />
              Relancer la connexion
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem className={cn(BUI_MENU_ITEM, "text-destructive-text")} disabled={!runtime.id} onSelect={() => setConfirming(true)}>
            <IconTrash className="size-4 shrink-0" aria-hidden />
            Retirer
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RuntimeRemovalDialog runtime={runtime} open={confirming} onClose={() => setConfirming(false)} />
    </>
  );
}

/** Online, or since when it is not: the one fact a machine line must give. */
function MachineState({ runtime }: { runtime: RuntimePublicDto }) {
  const { t, formatDate } = useT();
  const health = displayedRuntimeHealth(runtime);
  if (health === "healthy") return <ToneBadge tone="success">En ligne</ToneBadge>;
  // « Hors ligne » only for a closed link: a refused login or a missing
  // provider keeps its own label, it does not call for the same gesture.
  const seenAt = runtime.link?.lastSeenAt;
  return (
    <ToneBadge tone="warning">
      {health === "disconnected" && seenAt
        ? `Hors ligne depuis ${formatDate(seenAt)}`
        : t(HEALTH_LABEL[health === "not_configured" ? "unknown" : health])}
    </ToneBadge>
  );
}

/** The machine that serves bots with no machine of their own. */
function DefaultMachineCard({ runtime, busy, onDiagnose }: { runtime: RuntimePublicDto; busy: boolean; onDiagnose?: () => void }) {
  const name = runtime.name ?? "Machine par défaut";
  const offline = displayedRuntimeHealth(runtime) !== "healthy";
  return (
    <section aria-label={name} className="space-y-2 rounded-xl border border-border px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <IconServer2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <p className="min-w-0 truncate text-sm font-medium">{name}</p>
          <ToneBadge tone="info">Par défaut</ToneBadge>
        </div>
        <MachineMenu runtime={runtime} label={name} disabled={busy} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{runtime.engine === "hermes" ? "Serveur Hermes" : runtime.engine}</span>
        <MachineState runtime={runtime} />
        {offline && onDiagnose ? (
          <button type="button" className={BUTTON.small} onClick={onDiagnose}>Diagnostiquer</button>
        ) : null}
      </div>
    </section>
  );
}

/** A machine paired by `edge-setup connect`: one line per agent CLI. */
function AgentMachineCard({ machine, agents, busy, onRelaunch }: {
  machine: string;
  agents: RuntimePublicDto[];
  busy: boolean;
  onRelaunch: () => void;
}) {
  return (
    <section aria-label={machine} className="space-y-2 rounded-xl border border-border px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <IconTerminal2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <p className="min-w-0 truncate text-sm font-medium">{machine}</p>
          <span className="text-xs text-muted-foreground">Agents locaux</span>
        </div>
        <button type="button" className={BUTTON.small} disabled={busy} onClick={onRelaunch}>
          <IconRefresh className="size-3.5" aria-hidden />
          Relancer
        </button>
      </div>
      <ul className="divide-y divide-border/60">
        {agents.map((runtime) => {
          const agent = isLocalEngine(runtime.engine) ? LOCAL_ENGINES[runtime.engine] : null;
          // A runtime paired before `connect` has no « · agent » in its name.
          const label = agent?.label ?? runtime.engine;
          return (
            <li key={runtime.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="flex min-w-0 items-center gap-2">
                {agent ? <ProviderIcon provider={agent.provider} className="size-4 shrink-0" decorative withTitle={false} /> : null}
                <span className="min-w-0 truncate text-sm">{label}</span>
                {runtime.engineVersion ? <span className="text-xs text-muted-foreground">v{runtime.engineVersion}</span> : null}
              </div>
              <div className="flex items-center gap-2">
                <MachineState runtime={runtime} />
                <MachineMenu runtime={runtime} label={`${machine} · ${label}`} disabled={busy} />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The runtime waiting to replace the current one: an organization has only ONE
 * runtime, a second exists only for the duration of a replacement.
 *
 * Off desktop as on desktop, it is a card: there is at most one (the API
 * refuses to declare a second, `RUNTIME_REPLACEMENT_PENDING`), a table of
 * runtimes no longer has an object.
 */
function PendingRuntimeCard({
  runtime,
  hasActive,
  busy,
  onReplace,
}: {
  runtime: RuntimePublicDto;
  /** With no runtime serving, the gesture is not a replacement: it puts it into service. */
  hasActive: boolean;
  busy: boolean;
  onReplace: (runtime: RuntimePublicDto) => void;
}) {
  const { t, formatDate } = useT();
  const environment = useDeployEnvironment();
  const status = displayedRuntimeHealth(runtime);
  const shown = status === "not_configured" ? "unknown" : status;
  // The kind of link follows the connection: the old one and the new one often
  // carry the same name, the connection distinguishes them.
  const kind = runtime.reachability === "connector" ? linkKind(runtime.link?.origin, environment) : null;
  const reach = runtime.reachability !== "connector"
    ? t("cloudRuntimeSettings.reachDirect")
    : kind ? `${t("cloudRuntimeSettings.reachConnector")} · ${kind.label}` : t("cloudRuntimeSettings.reachConnector");
  const seenAt = runtime.reachability === "connector" ? runtime.link?.lastSeenAt : runtime.lastCheckedAt;
  const seen = seenAt ? t("cloudRuntimeSettings.seenAt", { date: formatDate(seenAt) }) : t("cloudRuntimeSettings.neverSeen");
  return (
    <div className="space-y-2 rounded-xl border border-dashed border-border px-3 py-2.5" data-pending-runtime={runtime.id ?? ""}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-semibold">{runtime.name}</p>
        <ToneBadge tone={shown === "healthy" ? "success" : "warning"}>{t(HEALTH_LABEL[shown])}</ToneBadge>
      </div>
      <p className="text-xs text-muted-foreground">{t("cloudRuntimeSettings.pendingLabel")} · {reach} · {seen}</p>
      <div className={ACTIONS}>
        <button type="button" className={BUTTON.primary} disabled={busy || !runtime.id} onClick={() => onReplace(runtime)}>
          {t(hasActive ? "cloudRuntimeSettings.replaceAction" : "cloudRuntimeSettings.useAction")}
        </button>
        {runtime.reachability === "direct" ? <RuntimeDirectActions runtime={runtime} /> : null}
        <RuntimeRemoval runtime={runtime} disabled={busy} />
      </div>
    </div>
  );
}

/**
 * The replacement's confirmation: what leaves with the old runtime.
 *
 * A bot is attached to no runtime, but its Hermes profile (persona,
 * skills, MCP) exists only on the host where it was created. After the
 * replacement, each run leaves for the new host: the box says so before the
 * click, with the path for importing the agents.
 */
function ReplaceRuntimeDialog({
  current,
  next,
  busy,
  onConfirm,
  onClose,
}: {
  current: RuntimePublicDto;
  next: RuntimePublicDto;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t, plural } = useT();
  const roster = useQuery({ queryKey: queryKeys.roster, queryFn: api.roster });
  const botCount = (roster.data?.bots ?? []).filter((bot) => !bot.archivedAt).length;
  // A runtime with no name is said « Runtime » rather than a sentence with a hole.
  const names = { current: current.name ?? t("cloudRuntimeSettings.addTitle"), next: next.name ?? t("cloudRuntimeSettings.addTitle") };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("cloudRuntimeSettings.replaceConfirmTitle", names)}
      role="alertdialog"
      closeLabel={t("common.close")}
      footer={<>
        <button type="button" className={BUTTON.secondary} disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
        <button type="button" className={BUTTON.danger} disabled={busy} onClick={onConfirm}>{t("cloudRuntimeSettings.replaceConfirm")}</button>
      </>}
    >
      <div className="space-y-3">
        <Note tone="warning" role="alert">{t("cloudRuntimeSettings.replaceConfirmNote", names)}</Note>
        {botCount > 0 ? (
          <Note tone="info">
            {plural(botCount, {
              one: t("cloudRuntimeSettings.replaceBotsNote_one", { ...names, count: botCount }),
              other: t("cloudRuntimeSettings.replaceBotsNote_other", { ...names, count: botCount }),
            })}{" "}
            <Link to="/settings/agents" className="font-medium underline underline-offset-2">{t("cloudRuntimeSettings.replaceImportLink")}</Link>
          </Note>
        ) : null}
      </div>
    </Dialog>
  );
}

/**
 * The register while it is read: the table's geometry, in grey.
 *
 * Without it, the request in flight rendered exactly the card of an organization
 * with no runtime: « je n'ai pas encore répondu » read as « vous n'en avez
 * aucun », and the first render contradicted the second.
 */
function RuntimeRegistrySkeleton() {
  const { t } = useT();
  return (
    <div role="status" aria-label={t("cloudRuntimeSettings.registryLoadingLabel")} className="space-y-2 rounded-xl border border-border p-4">
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} className="h-9 w-full rounded-md motion-reduce:animate-none" />
      ))}
    </div>
  );
}


/**
 * Add the organization's runtime, or replace it: an organization
 * has only ONE.
 *
 * Changing machine (going from the local workstation to a VPS) is done with no gap:
 * the new one is paired and waits here without serving the runs; the
 * replacement probes it, puts it into service and revokes the old one in the same
 * transaction. The free switch between runtimes is removed: a bot is
 * attached to no runtime, and switching ran every bot on a
 * host where their profiles did not exist.
 */
export function RuntimeReplacement({ activeId, initiallyAdding = false, onDiagnose }: {
  activeId: string | null;
  initiallyAdding?: boolean;
  /** Opens the default machine's « État » section, where the link is diagnosed. */
  onDiagnose?: () => void;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [isAdding, setIsAdding] = useState(initiallyAdding);
  const [added, setAdded] = useState<RuntimePublicDto | null>(null);
  const [replacing, setReplacing] = useState<RuntimePublicDto | null>(null);
  const [draftName, setDraftName] = useState("");
  const [reachability, setReachability] = useState<"connector" | "direct">("connector");
  // The add starts with a choice: the agent CLIs of a machine, or a Hermes server.
  // Onboarding waits for a default machine, which only a Hermes server gives:
  // it opens straight on that one.
  const [addKind, setAddKind] = useState<"agents" | "hermes" | null>(initiallyAdding ? "hermes" : null);
  const list = useQuery({ queryKey: queryKeys.runtimeList, queryFn: api.runtimeList, refetchInterval: RUNTIME_REFETCH_MS });
  const replace = useMutation({
    mutationFn: api.replaceRuntime,
    onSuccess: async (runtime) => {
      setReplacing(null);
      setAdded(null);
      toast.success(t("cloudRuntimeSettings.replaceSuccess", { name: runtime.name ?? t("cloudRuntimeSettings.addTitle") }));
      await invalidateRuntimeQueries(queryClient);
    },
    onError: (error) => toast.error(errorMessage(error, t("cloudRuntimeSettings.replaceFailed"))),
  });

  const [ticket, setTicket] = useState<RuntimeEnrollmentTicketDto | null>(null);
  const enroll = useMutation({
    // `machine`: one ticket for every agent CLI of the machine (`edge-setup connect`).
    mutationFn: ({ name, machine }: { name: string; machine?: true }) => api.openRuntimeEnrollment({ name, machine }),
    onSuccess: (opened) => setTicket(opened),
    onError: (error) => toast.error(errorMessage(error, "L’ouverture de l’appairage a échoué.")),
  });

  const runtimes = list.data ?? [];
  const active = runtimes.find((runtime) => runtime.isActive) ?? null;
  const pending = runtimes.filter((runtime) => !runtime.isActive && !runtime.dedicated);
  const dedicated = runtimes.filter((runtime) => runtime.dedicated);
  // A machine ticket names each agent's runtime « <machine> · <agent> »: one
  // card per machine, one line per agent.
  const machines = [...dedicated.reduce((groups, runtime) => {
    // The agent's label is the last « · » part: a machine name may hold one too.
    const cut = runtime.name?.lastIndexOf(" · ") ?? -1;
    const machine = runtime.name ? (cut > 0 ? runtime.name.slice(0, cut) : runtime.name) : t("newBotDialog.rulesServerFallback");
    return groups.set(machine, [...(groups.get(machine) ?? []), runtime]);
  }, new Map<string, RuntimePublicDto[]>())];
  // Three silences looked alike: a read in progress, a failed read, a registry
  // really empty. `list.data ?? []` crushed all three into « aucun
  // runtime », so an API outage read as a new organization.
  const registryState: "loading" | "failed" | "empty" | "listed" = list.isPending
    ? "loading"
    : list.error
      ? "failed"
      : runtimes.length === 0
        ? "empty"
        : "listed";
  // The API's word on the failure, if it has one; empty otherwise.
  const listFailure = list.error ? errorMessage(list.error, "") : "";
  const localMachine = nativeBridge()?.localMachine;
  const stopDesktop = useMutation({
    mutationFn: async () => localMachine?.stop(),
    onSuccess: () => invalidateRuntimeQueries(queryClient),
    onError: (error) => toast.error(errorMessage(error, "L’arrêt des agents a échoué.")),
  });
  const attachDesktop = useMutation({
    mutationFn: async () => {
      if (!localMachine) return false;
      const enrollment = await api.openRuntimeEnrollment({ name: draftName.trim() || "Cet ordinateur", machine: true });
      if (!enrollment.workspaceId) throw new Error("L’identifiant de l’espace d’appairage est absent.");
      return localMachine.start(enrollment.ticket, enrollment.workspaceId);
    },
    onSuccess: async (attached) => {
      if (!attached) return;
      closeDraft();
      await invalidateRuntimeQueries(queryClient);
    },
    onError: (error) => toast.error(errorMessage(error, "La connexion des agents a échoué.")),
  });
  const busy = replace.isPending || enroll.isPending || attachDesktop.isPending || stopDesktop.isPending;
  // With no runtime serving, putting the replacement into service removes nothing:
  // no confirmation to read.
  const startReplace = (runtime: RuntimePublicDto): void => {
    if (!runtime.id) return;
    if (active) setReplacing(runtime);
    else replace.mutate(runtime.id);
  };
  const canEnroll = draftName.trim().length > 0;
  const closeDraft = (): void => {
    setIsAdding(false);
    setTicket(null);
    setDraftName("");
    setReachability("connector");
    setAddKind(null);
  };
  // `connect` again re-pairs a revoked agent and restarts the user service.
  const relaunch = (machine: string): void => enroll.mutate({ name: machine, machine: true });
  return (
    <SettingsCard className="space-y-3">
      <CardHeading
        title="Vos machines"
        description="Chaque bot s’exécute sur la machine par défaut, ou sur l’agent choisi à sa création."
        action={registryState === "listed" ? (
          <div className="flex flex-wrap gap-2">
            {localMachine && dedicated.length > 0 ? (
              <button type="button" className={BUTTON.secondary} disabled={busy} onClick={() => stopDesktop.mutate()}>
                Arrêter les agents de cet ordinateur
              </button>
            ) : null}
            <button type="button" className={BUTTON.primary} disabled={busy} onClick={() => setIsAdding(true)}>
              Ajouter une machine
            </button>
          </div>
        ) : undefined}
      />
      {added ? <Dialog open onClose={() => setAdded(null)} title={t("cloudRuntimeSettings.addedTitle")} footer={<>
        <button type="button" className={BUTTON.secondary} onClick={() => setAdded(null)}>{t("common.close")}</button>
        {/* Declared with no runtime serving, it already serves: only a replacement waits for a gesture. */}
        {added.isActive ? null : (
          <button type="button" className={BUTTON.primary} disabled={busy || !added.id} onClick={() => startReplace(added)}>
            {t("cloudRuntimeSettings.addedReplace")}
          </button>
        )}
      </>}>
        <p className="mb-4 text-center font-medium">{t("cloudRuntimeSettings.addedFlow")}</p>
        {added.isActive ? null : <Note tone="info">{t("cloudRuntimeSettings.addedNote")}</Note>}
        <RuntimeDirectStatus runtime={added} />
      </Dialog> : null}
      {replacing && active ? (
        <ReplaceRuntimeDialog
          current={active}
          next={replacing}
          busy={replace.isPending}
          onClose={() => setReplacing(null)}
          onConfirm={() => { if (replacing.id) replace.mutate(replacing.id); }}
        />
      ) : null}
      {registryState === "loading" ? (
        <RuntimeRegistrySkeleton />
      ) : registryState === "failed" ? (
        <Note tone="danger" role="alert">
          {/*
            The API may name the outage; what it implies for the screen (it
            does not show the real state) is always said, not only when
            it stays silent.
          */}
          {listFailure ? `${listFailure} ` : null}
          {t("cloudRuntimeSettings.registryFailed")}{" "}
          <button
            type="button"
            className="font-medium underline underline-offset-2"
            onClick={() => void list.refetch()}
          >
            Réessayer
          </button>
        </Note>
      ) : registryState === "empty" ? (
        <EmptyState
          icon={<IconServerBolt />}
          title="Aucune machine"
          description="Connectez les agents de votre ordinateur (Codex, Claude Code, Grok, Gemini, OpenCode) ou un serveur Hermes : la machine ouvre elle-même la connexion vers openedbot."
          actions={(
            <button type="button" className={BUTTON.primary} disabled={busy} onClick={() => setIsAdding(true)}>
              Ajouter une machine
            </button>
          )}
        />
      ) : (
        <>
          {active ? <DefaultMachineCard runtime={active} busy={busy} onDiagnose={onDiagnose} /> : null}
          {pending.map((runtime) => (
            <PendingRuntimeCard
              key={runtime.id ?? runtime.baseUrl}
              runtime={runtime}
              hasActive={active !== null}
              busy={busy}
              onReplace={startReplace}
            />
          ))}
          {machines.map(([machine, agents]) => (
            <AgentMachineCard key={machine} machine={machine} agents={agents} busy={busy} onRelaunch={() => relaunch(machine)} />
          ))}
        </>
      )}
      <RuntimePendingExposures />
      {activeId === null && pending.length > 0 ? (
        <Note tone="warning" role="alert">{t("cloudRuntimeSettings.noActive")}</Note>
      ) : null}
      {ticket ? (
        <RuntimeEnrollmentDialog
          ticket={ticket}
          onDone={closeDraft}
          onCancel={closeDraft}
        />
      ) : isAdding && addKind === null ? (
        <Dialog open onClose={closeDraft} title="Ajouter une machine" className={ENROLLMENT_DIALOG_WIDTH}>
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              className="space-y-1.5 rounded-xl border border-border p-4 text-left transition-colors hover:bg-[var(--btn-veil)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setAddKind("agents")}
            >
              <IconTerminal2 className="size-5 text-muted-foreground" aria-hidden />
              <p className="text-sm font-medium">Les agents d’une machine</p>
              <p className="text-xs leading-5 text-muted-foreground">
                Codex, Claude Code, Grok, Gemini, OpenCode déjà installés : une commande les connecte tous.
              </p>
            </button>
            <button
              type="button"
              className="space-y-1.5 rounded-xl border border-border p-4 text-left transition-colors hover:bg-[var(--btn-veil)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setAddKind("hermes")}
            >
              <IconServer2 className="size-5 text-muted-foreground" aria-hidden />
              <p className="text-sm font-medium">Un serveur Hermes</p>
              <p className="text-xs leading-5 text-muted-foreground">
                Installe Hermes sur un serveur Linux et le relie à openedbot, sans port entrant.
              </p>
            </button>
          </div>
        </Dialog>
      ) : isAdding && addKind === "agents" ? (
        <Dialog
          open
          onClose={closeDraft}
          title="Connecter les agents d’une machine"
          className={ENROLLMENT_DIALOG_WIDTH}
          footer={<>
            <button type="button" className={BUTTON.secondary} disabled={busy} onClick={() => setAddKind(null)}>
              Retour
            </button>
            {localMachine ? (
              <button type="button" className={BUTTON.secondary} disabled={busy} onClick={() => attachDesktop.mutate()}>
                {attachDesktop.isPending ? "Connexion des agents…" : "Ajouter cet ordinateur"}
              </button>
            ) : null}
            <button type="button" className={BUTTON.primary} disabled={busy || !canEnroll}
              onClick={() => enroll.mutate({ name: draftName.trim(), machine: true })}>
              Obtenir la commande
            </button>
          </>}
        >
          <form className="space-y-3" onSubmit={(event) => {
            event.preventDefault();
            if (canEnroll && !busy) enroll.mutate({ name: draftName.trim(), machine: true });
          }}>
            <div className="space-y-2">
              <Label htmlFor="machine-add-name">Nom de la machine</Label>
              <Input
                id="machine-add-name"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                placeholder="ubuntu-server"
                autoComplete="off"
              />
            </div>
            <p className="text-sm text-muted-foreground">
              Connectez-vous d’abord à chaque CLI sur cette machine. L’étape suivante donne les commandes à lancer dans votre dossier de travail.
            </p>
          </form>
        </Dialog>
      ) : isAdding ? (
        <Dialog
          open
          onClose={closeDraft}
          title="Ajouter un serveur Hermes"
          className={reachability === "direct" ? DIRECT_DIALOG_WIDTH : ENROLLMENT_DIALOG_WIDTH}
          bodyClassName="flex flex-col overflow-y-hidden"
          footer={reachability === "connector" ? (
            <>
              <button type="button" className={BUTTON.secondary} disabled={busy} onClick={() => setAddKind(null)}>
                Retour
              </button>
              <button
                type="button"
                className={BUTTON.primary}
                disabled={busy || !canEnroll || pending.length > 0}
                onClick={() => enroll.mutate({ name: draftName.trim() })}
              >
                Appairer Hermes
              </button>
            </>
          ) : undefined}
        >
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <RuntimeReachabilityPicker value={reachability} onChange={setReachability} />
          {reachability === "direct" ? <RuntimeDirectWizard onDone={(saved) => { closeDraft(); setAdded(saved); }} onCancel={closeDraft} /> : (
          <div className="scrollbar-subtle scroll-y-ring-safe min-h-0 flex-1 space-y-3">
          <div className="space-y-2">
            <Label htmlFor="runtime-add-name">Nom</Label>
            <Input
              id="runtime-add-name"
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              placeholder="VPS production"
            />
          </div>
          <p className="text-sm text-muted-foreground">
            Aucune URL Hermes ni aucun bearer à exposer : la machine ouvre elle-même la connexion sortante sécurisée vers openedbot.
          </p>
          {/*
            Installation comes before the ticket: it dies in five minutes, and
            `up` (runtime, gateway on loopback, connector) can last
            longer. Showing it only afterwards meant leaving the operator
            to launch a `link` with no binary on the machine.
          */}
          <div className="space-y-2">
            <p className="text-sm font-medium">Dans le terminal de votre serveur Linux (Debian 12+ ou Ubuntu 24.04+)</p>
            <ol className="space-y-4">
              {EDGE_SETUP_INSTALL_STEPS.map((step, index) => (
                <EnrollmentStep
                  key={step.value}
                  index={index + 1}
                  title={step.title}
                  value={step.value}
                  copyLabel="La commande"
                  prefix="$"
                >
                  {step.hint}
                </EnrollmentStep>
              ))}
            </ol>
            <p className="text-xs leading-5 text-muted-foreground">Le ticket est valable cinq minutes.</p>
          </div>
          </div>
          )}
        </div>
        </Dialog>
      ) : null}
    </SettingsCard>
  );
}
