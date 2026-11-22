import { RuntimeDirectActions } from "../../../../components/runtime-direct";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { IconDots, IconRefresh, IconServer2, IconTerminal2, IconTrash } from "@tabler/icons-react";
import {
  cn,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  toast,
} from "@openedbot/browser-ui-kit";
import { api, errorMessage } from "../../../../lib/api";
import { displayedRuntimeHealth } from "../../../../lib/runtime/runtime-health";
import { linkKind, useDeployEnvironment } from "../../../../lib/platform/deploy-environment";
import { useT } from "../../../../lib/i18n";
import { isLocalEngine, LOCAL_ENGINES, type RuntimePublicDto } from "@openedbot/contracts-api";
import { ACTIONS, BUTTON, Note, ToneBadge } from "../../../../components/settings/primitives";
import { HEALTH_LABEL, invalidateRuntimeQueries } from "./cloud-shared";
import { ProviderIcon } from "../../../../components/provider-icon";
import { BUI_MENU_ITEM, BUI_POPOVER } from "../../../../components/boardui/menu";

/*
  The machine list's pieces (cloud-registry.tsx): a runtime's removal, the
  « … » menu, and one card per kind of machine (default, agents, pending).
*/

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
export function DefaultMachineCard({ runtime, busy, onDiagnose }: { runtime: RuntimePublicDto; busy: boolean; onDiagnose?: () => void }) {
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
export function AgentMachineCard({ machine, agents, busy, onRelaunch }: {
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
export function PendingRuntimeCard({
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
