import { useAccountWorkspaces } from "../../../components/workspace/workspace-navigation";
import { EnrollmentStep } from "../../../components/runtime-command";
import {
  DIRECT_DIALOG_WIDTH,
  RuntimeDirectWizard,
  RuntimeDirectActions,
  RuntimeDirectStatus,
  RuntimePendingExposures,
  RuntimeReachabilityPicker,
} from "../../../components/runtime-direct";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconServerBolt } from "@tabler/icons-react";
import {
  cn,
  Dialog,
  Input,
  Label,
  Skeleton,
  toast,
} from "@openedbot/browser-ui-kit";
import { Link } from "@tanstack/react-router";
import { api, errorMessage, queryKeys } from "../../../lib/api";
import { displayedRuntimeHealth } from "../../../lib/runtime-health";
import { linkKind, useDeployEnvironment } from "../../../lib/deploy-environment";
import { useT } from "../../../lib/i18n";
import type { RuntimeEnrollmentTicketDto, RuntimePublicDto } from "@openedbot/contracts-api";
import {
  ACTIONS,
  BUTTON,
  CardHeading,
  EmptyState,
  Note,
  SettingsCard,
  ToneBadge,
} from "../../../components/settings/primitives";
import { HEALTH_LABEL, RUNTIME_REFETCH_MS, invalidateRuntimeQueries } from "./cloud-shared";
import {
  EDGE_SETUP_INSTALL_STEPS,
  ENROLLMENT_DIALOG_WIDTH,
  RuntimeEnrollmentDialog,
} from "./cloud-enrollment";

/**
 * Le retrait d'un runtime : le bouton, et sa confirmation quand il sert les
 * runs.
 *
 * Il vit aux DEUX endroits où l'on regarde un runtime : la carte « Runtime
 * actif » de l'écran et la carte du remplaçant en attente.
 *
 * L'actif passe par une modal parce qu'il est le seul dont le retrait coupe
 * les runs ; un remplaçant en attente ne sert rien, donc le second geste
 * serait du bruit.
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
  const { t } = useT();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: (confirm: boolean) => {
      if (!runtime.id) throw new Error("runtime");
      return api.deleteRuntime(runtime.id, confirm);
    },
    onSuccess: async () => {
      setConfirming(false);
      toast.success("Runtime retiré.");
      await invalidateRuntimeQueries(queryClient);
    },
    onError: (error) => toast.error(errorMessage(error, "Le retrait du runtime a échoué.")),
  });
  return (
    <>
      {/*
        `danger` et non `ghost` : le geste détruit un lien qu'il faudra
        réappairer à la main sur l'hôte. Il se lit comme tel avant le clic,
        pas seulement dans la modal qui suit.
      */}
      <button
        type="button"
        className={cn(BUTTON.danger, className)}
        disabled={disabled || remove.isPending || !runtime.id}
        onClick={() => (runtime.isActive ? setConfirming(true) : remove.mutate(false))}
        aria-label={`Retirer ${runtime.name}`}
      >
        Retirer
      </button>
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Retirer ${runtime.name} ?`}
        description="Ce runtime sert les runs. Une fois retiré, plus rien ne les sert tant qu’un nouveau n’est pas appairé. Pour changer de machine, préférez Remplacer : il n’y a pas de trou."
        role="alertdialog"
        closeLabel={t("common.close")}
      >
        <div className="space-y-4">
          <Note tone="warning" role="alert">
            Les runs en cours sur cet hôte s’arrêtent, et son lien sortant est fermé sur-le-champ : le jeton posé sur la machine n’ouvre plus rien. Il faudra réappairer pour le reconnecter.
          </Note>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={BUTTON.secondary} disabled={remove.isPending} onClick={() => setConfirming(false)}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className={BUTTON.danger}
              disabled={remove.isPending}
              onClick={() => remove.mutate(true)}
            >
              Retirer quand même
            </button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

/**
 * Le runtime qui attend de remplacer l'actuel : une organisation n'a qu'UN
 * runtime, un second n'existe que le temps d'un remplacement.
 *
 * Hors bureau comme au bureau, c'est une carte : il y en a au plus une (l'API
 * refuse d'en déclarer une seconde, `RUNTIME_REPLACEMENT_PENDING`), le tableau
 * d'un parc n'a plus d'objet.
 */
function PendingRuntimeCard({
  runtime,
  hasActive,
  busy,
  onReplace,
}: {
  runtime: RuntimePublicDto;
  /** Sans runtime qui sert, le geste n'est pas un remplacement : il le met en service. */
  hasActive: boolean;
  busy: boolean;
  onReplace: (runtime: RuntimePublicDto) => void;
}) {
  const { t, formatDate } = useT();
  const environment = useDeployEnvironment();
  const status = displayedRuntimeHealth(runtime);
  const shown = status === "not_configured" ? "unknown" : status;
  // Le genre de lien suit la connexion : l'ancien et le nouveau portent
  // souvent le même nom, la connexion les distingue.
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
 * La confirmation du remplacement : ce qui part avec l'ancien runtime.
 *
 * Un bot n'est rattaché à aucun runtime, mais son profil Hermes (persona,
 * skills, MCP) n'existe que sur l'hôte où il a été créé. Après le
 * remplacement, chaque run part vers le nouvel hôte : la boîte le dit avant le
 * clic, avec le chemin pour importer les agents.
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
  // Un runtime sans nom se dit « Runtime » plutôt qu'une phrase trouée.
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
 * Le registre pendant sa lecture : la géométrie du tableau, en gris.
 *
 * Sans lui, la requête en vol rendait exactement la carte d'une organisation
 * sans runtime : « je n'ai pas encore répondu » se lisait « vous n'en avez
 * aucun », et le premier rendu démentait le second.
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
 * Ajouter le runtime de l'organisation, ou le remplacer : une organisation
 * n'en a qu'UN.
 *
 * Changer de machine (passer du poste local à un VPS) se fait sans trou :
 * la nouvelle est appairée et attend ici sans servir les runs ; le
 * remplacement la sonde, la met en service et révoque l'ancienne dans la même
 * transaction. La bascule libre entre runtimes est retirée : un bot n'est
 * rattaché à aucun runtime, et basculer faisait tourner tous les bots sur un
 * hôte où leurs profils n'existaient pas.
 */
export function RuntimeReplacement({ activeId, initiallyAdding = false }: { activeId: string | null; initiallyAdding?: boolean }) {
  const { t } = useT();
  const account = useAccountWorkspaces();
  const queryClient = useQueryClient();
  const [isAdding, setIsAdding] = useState(initiallyAdding);
  const [added, setAdded] = useState<RuntimePublicDto | null>(null);
  const [replacing, setReplacing] = useState<RuntimePublicDto | null>(null);
  const [draftName, setDraftName] = useState("");
  const [reachability, setReachability] = useState<"connector" | "direct">("connector");
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
    mutationFn: () => api.openRuntimeEnrollment({
      name: draftName.trim(),
    }),
    onSuccess: (opened) => setTicket(opened),
    onError: (error) => toast.error(errorMessage(error, "L’ouverture de l’appairage a échoué.")),
  });

  const runtimes = list.data ?? [];
  const active = runtimes.find((runtime) => runtime.isActive) ?? null;
  const pending = runtimes.filter((runtime) => !runtime.isActive);
  // Trois silences se ressemblaient : lecture en cours, lecture en échec, parc
  // réellement vide. `list.data ?? []` les écrasait tous les trois en « aucun
  // runtime », donc une panne de l'API se lisait comme une organisation neuve.
  const registryState: "loading" | "failed" | "empty" | "listed" = list.isPending
    ? "loading"
    : list.error
      ? "failed"
      : runtimes.length === 0
        ? "empty"
        : "listed";
  // Le mot de l'API sur la panne, s'il en a un ; vide sinon.
  const listFailure = list.error ? errorMessage(list.error, "") : "";
  const busy = replace.isPending || enroll.isPending;
  // Sans runtime qui sert, mettre le remplaçant en service n'enlève rien :
  // pas de confirmation à lire.
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
  };
  return (
    <SettingsCard className="space-y-3">
      <CardHeading
        title={t(active ? "cloudRuntimeSettings.replaceTitle" : "cloudRuntimeSettings.addTitle")}
        description={t(active ? "cloudRuntimeSettings.replaceDescription" : "cloudRuntimeSettings.addDescription")}
      />
      {added ? <Dialog open onClose={() => setAdded(null)} title={t("cloudRuntimeSettings.addedTitle")} footer={<>
        <button type="button" className={BUTTON.secondary} onClick={() => setAdded(null)}>{t("common.close")}</button>
        {/* Déclaré sans runtime qui sert, il sert déjà : seul un remplaçant attend un geste. */}
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
            L'API peut nommer la panne ; ce qu'elle implique pour l'écran (il
            ne montre pas l'état réel) se dit toujours, pas seulement quand
            elle se tait.
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
          title="Aucun runtime déclaré"
          description="Déclarez la machine qui exécutera vos runs : c’est elle qui ouvre la connexion vers openedbot, aucune URL ni aucun jeton ne sort d’ici."
          actions={(
            <button type="button" className={BUTTON.primary} disabled={busy} onClick={() => setIsAdding(true)}>
              {t("cloudRuntimeSettings.addAction")}
            </button>
          )}
        />
      ) : (
        pending.map((runtime) => (
          <PendingRuntimeCard
            key={runtime.id ?? runtime.baseUrl}
            runtime={runtime}
            hasActive={active !== null}
            busy={busy}
            onReplace={startReplace}
          />
        ))
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
      ) : isAdding ? (
        <Dialog
          open
          onClose={closeDraft}
          title={t(active ? "cloudRuntimeSettings.replaceStart" : "cloudRuntimeSettings.addAction")}
          className={reachability === "direct" ? DIRECT_DIALOG_WIDTH : ENROLLMENT_DIALOG_WIDTH}
          bodyClassName="flex flex-col overflow-y-hidden"
          footer={reachability === "connector" ? (
            <>
              <button type="button" className={BUTTON.secondary} disabled={busy} onClick={closeDraft}>
                Annuler
              </button>
              <button
                type="button"
                className={BUTTON.primary}
                disabled={busy || !canEnroll}
                onClick={() => enroll.mutate()}
              >
                Appairer depuis le serveur
              </button>
            </>
          ) : undefined}
        >
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {!account.data?.agencyAvailable && <RuntimeReachabilityPicker value={reachability} onChange={setReachability} />}
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
            L'installation précède le ticket : il meurt en cinq minutes, et
            `up` (runtime, gateway sur loopback, connector) peut durer plus
            longtemps. La montrer seulement après, c'était laisser l'opérateur
            lancer un `link` sans binaire sur la machine.
          */}
          <div className="space-y-2">
            <p className="text-sm font-medium">D’abord, sur la machine (Debian 12+ ou Ubuntu 24.04+)</p>
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
            <p className="text-xs leading-5 text-muted-foreground">
              Déjà fait sur cette machine ? Passez directement à l’appairage. Le ticket, valable cinq minutes, ne s’ouvre qu’au clic sur « Appairer depuis le serveur ».
            </p>
          </div>
          {/*
            L'appairage est la voie par défaut : il évite d'aller chercher le
            bearer soi-même, donc de le faire passer par un terminal et un
            presse-papiers. La saisie reste offerte à qui l'a déjà sous la main.
          */}
          </div>
          )}
        </div>
        </Dialog>
      ) : registryState !== "listed" || pending.length > 0 ? null : (
        // Un remplaçant à la fois : tant qu'il attend, l'API refuse d'en
        // appairer un autre (`RUNTIME_REPLACEMENT_PENDING`), le bouton aussi.
        <div className="flex justify-end">
          <button type="button" className={BUTTON.secondary} disabled={busy} onClick={() => setIsAdding(true)}>
            {t(active ? "cloudRuntimeSettings.replaceStart" : "cloudRuntimeSettings.addAction")}
          </button>
        </div>
      )}
    </SettingsCard>
  );
}
