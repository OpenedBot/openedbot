import { EnrollmentStep } from "../../../../components/runtime-command";
import {
  DIRECT_DIALOG_WIDTH,
  RuntimeDirectWizard,
  RuntimeDirectStatus,
  RuntimePendingExposures,
  RuntimeReachabilityPicker,
} from "../../../../components/runtime-direct";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconServer2, IconServerBolt, IconTerminal2 } from "@tabler/icons-react";
import {
  Dialog,
  Input,
  Label,
  Skeleton,
  toast,
} from "@openedbot/browser-ui-kit";
import { Link } from "@tanstack/react-router";
import { api, errorMessage, queryKeys } from "../../../../lib/api";
import { useT } from "../../../../lib/i18n";
import { type RuntimeEnrollmentTicketDto, type RuntimePublicDto } from "@openedbot/contracts-api";
import {
  BUTTON,
  CardHeading,
  EmptyState,
  Note,
  SettingsCard,
} from "../../../../components/settings/primitives";
import { nativeBridge } from "../../../../lib/platform";
import { RUNTIME_REFETCH_MS, invalidateRuntimeQueries } from "./cloud-shared";
import {
  EDGE_SETUP_INSTALL_STEPS,
  ENROLLMENT_DIALOG_WIDTH,
  RuntimeEnrollmentDialog,
} from "./cloud-enrollment";
import { AgentMachineCard, DefaultMachineCard, PendingRuntimeCard } from "./cloud-machine-cards";

export { RuntimeRemoval } from "./cloud-machine-cards";

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
