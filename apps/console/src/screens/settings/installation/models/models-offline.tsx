import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { IconPlugConnectedX, IconServerBolt } from "@tabler/icons-react";
import { cn, DotMatrix, useIsMobile } from "@openedbot/browser-ui-kit";
import type { RuntimePublicDto } from "@openedbot/contracts-api";
import type { RuntimeHealthStatus } from "@openedbot/contracts-api";
import { ageSince } from "@openedbot/browser-i18n";
import { useT } from "../../../../lib/i18n";
import { BUTTON, EmptyState } from "../../../../components/settings/primitives";
import { SettingsPane } from "../../pane";
import { type RuntimeReadiness } from "./models-readiness";
import { FailureState, FailureSurface } from "../../../../components/failure-state";
import { runtimeHealthStatusLabel } from "../../../../lib/runtime/runtime-health";
import { RUNTIME_POLL_MS, type RuntimeOffline } from "./models-shared";

/**
 * Le runtime ne répond plus : ce qui est dessous date de sa dernière réponse.
 *
 * Le contenu reste en place, flouté, pour que l'écran garde sa forme, mais
 * aucun geste n'y passe (`inert`), comme `ConversationAvailability`. La carte
 * est `sticky` : sur un catalogue plus haut que la fenêtre, elle reste en vue
 * pendant le défilement. Configuration (lien) ou catalogue (runtime
 * injoignable) sont relus toutes les 3 s ; le voile se lève à la première
 * relecture qui prouve le retour, et son chronomètre est démonté avec lui.
 */
export function RuntimeOfflineVeil({
  offline,
  runtime,
  onRetry,
  className,
  children,
}: {
  offline: RuntimeOffline | null;
  runtime: RuntimePublicDto | null;
  onRetry: () => void;
  className?: string;
  children: ReactNode;
}) {
  const { t } = useT();
  const blocked = offline !== null;
  const name = runtime?.name ?? "Hermes";
  return (
    // `flex-1` : le voile descend jusqu'au bas du volet, même sur un contenu court.
    <div className="relative flex-1" data-runtime-offline={offline?.status}>
      <div
        inert={blocked}
        aria-hidden={blocked || undefined}
        className={cn(
          "transition-[filter,opacity] duration-300 motion-reduce:transition-none",
          className,
          blocked && "pointer-events-none select-none opacity-60 blur-sm",
        )}
      >
        {children}
      </div>
      {offline ? (
        <div className="absolute inset-0 z-20 bg-background/40 px-4 pt-6">
          {/* Centré dans la partie visible du volet : `top` d'un sticky se
              mesure sur le défileur, moins la moitié de la carte (~18rem).
              Sans transform, la carte ne remonte jamais sur l'en-tête. */}
          <div className="sticky top-[calc(50%-9rem)] mx-auto w-full max-w-md rounded-2xl border border-border bg-background p-6 shadow-[var(--shadow-elevated)]">
            <div role="alert" className="flex items-start gap-4">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-warn-soft text-warn-700">
                <IconPlugConnectedX aria-hidden className="size-5" />
              </span>
              <div className="min-w-0">
                <h2 className="text-base font-semibold">{t("modelsSettings.offlineTitle")}</h2>
                <p className="mt-1 break-words text-sm text-muted-foreground">
                  {t(offline.status === "disconnected" ? "modelsSettings.offlineDisconnected" : "modelsSettings.offlineUnreachable", { runtime: name })}
                </p>
              </div>
            </div>
            <RuntimeOfflineClock offline={offline} />
            <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
              {offline.status === "unreachable" ? (
                <button type="button" className={BUTTON.secondary} disabled={offline.checking} onClick={onRetry}>
                  {offline.checking ? t("modelsSettings.refreshing") : t("errorState.retry")}
                </button>
              ) : null}
              <Link to="/settings/runtime" className={BUTTON.primary}>
                {t("modelsSettings.openRuntimeSettings")}
              </Link>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Où s'arrête la requête, d'après la dernière vérification du runtime.
 *
 * Un runtime qui a REFUSÉ (token, capacité, fournisseur) a été atteint : le
 * lien vers lui est franchi et c'est lui qui répond non. Un runtime injoignable
 * ou au lien fermé n'a rien vu passer. Un runtime jamais testé non plus, pour
 * ce qu'on en sait : on ne dessine jamais un lien qu'on n'a pas vu franchi.
 */
const RUNTIME_ANSWERED: Readonly<Record<RuntimeHealthStatus, boolean>> = {
  healthy: true,
  unauthorized: true,
  missing_feature: true,
  no_provider: true,
  unreachable: false,
  disconnected: false,
  unknown: false,
};

/**
 * L'écran refermé sur ce qui manque, et sur l'endroit où ça se répare.
 *
 * Un écran Modèles ouvert sur un runtime non prouvé laisse choisir un modèle
 * dans un catalogue qui, au mieux, date de la dernière fois où Hermes a
 * répondu. Chaque état nomme donc sa cause et renvoie vers Edge, le
 * seul endroit où l'URL, le token et la connexion se corrigent. Le texte
 * renvoie vers la déclaration ou le diagnostic du runtime.
 *
 * Sans runtime, c'est un écran vide : une invitation, en gris. Dès qu'il y a
 * un runtime, il y a une cause, et l'écran parle comme `FailureState` : le
 * trajet s'arrête au runtime, et le pied de carte nomme lequel et dans quel
 * état. Runtime non prouvé : la cause est la dernière vérification connue,
 * c'est elle qui décide du trajet. Catalogue illisible alors que la dernière
 * vérification avait abouti : la cause est l'erreur vivante du catalogue,
 * avec son statut HTTP et sa référence.
 *
 * Dans les deux cas, le pied de carte date la dernière vérification
 * (`lastCheckedAt`) : « il y a 3 j » dit à lui seul si l'état affiché est
 * encore une information ou déjà un souvenir.
 */
export function RuntimeNotReady({
  readiness,
  runtime,
  catalogError,
}: {
  readiness: RuntimeReadiness;
  runtime: RuntimePublicDto | null;
  catalogError: unknown;
}) {
  const { t, locale } = useT();
  const isMobile = useIsMobile();
  const cta = readiness.state === "missing"
    ? t("modelsSettings.addRuntime")
    : t("modelsSettings.openRuntimeSettings");
  const action = <Link to="/settings/runtime" className={BUTTON.primary}>{cta}</Link>;
  const runtimeFact = { label: t("errorState.factRuntime"), value: runtime?.name ?? "-" };
  // Sans date, pas de fait : un « vérifié : » désignerait une vérification
  // qui n'a jamais eu lieu.
  const checkedFact = runtime?.lastCheckedAt
    ? [{ label: t("errorState.factChecked"), value: ageSince(locale, runtime.lastCheckedAt) }]
    : [];
  // La phrase de la dernière vérification, telle que le système l'a écrite,
  // jamais réécrite (règle de `FailureState`) ; la générique seulement à défaut.
  const lastHealthError = runtime?.lastHealthError?.trim() || null;
  const body = (() => {
    switch (readiness.state) {
      case "missing":
        return (
          <EmptyState
            icon={<IconServerBolt />}
            title={t("modelsSettings.emptyTitle")}
            description={t("modelsSettings.emptyDescription")}
            actions={isMobile ? undefined : action}
          />
        );
      case "unproven": {
        const answered = RUNTIME_ANSWERED[readiness.status];
        return (
          <FailureSurface
            icon={IconServerBolt}
            title={t("modelsSettings.unprovenTitle")}
            description={lastHealthError ?? t("modelsSettings.unprovenDescription")}
            tone="info"
            path={{
              shape: { hops: ["browser", "api", "runtime"], crossedIntoStop: answered },
              label: t(answered ? "errorState.runtimeAnsweredPath" : "errorState.upstreamPath"),
            }}
            facts={[
              runtimeFact,
              { label: t("errorState.factState"), value: runtimeHealthStatusLabel(readiness.status, locale), status: true },
              ...checkedFact,
            ]}
            action={isMobile ? undefined : action}
          />
        );
      }
      default:
        return (
          <FailureState
            error={catalogError}
            icon={IconServerBolt}
            title={t("modelsSettings.catalogUnreachableTitle")}
            fallback={t("modelsSettings.catalogUnreachableDescription")}
            facts={[runtimeFact, ...checkedFact]}
            action={isMobile ? undefined : action}
          />
        );
    }
  })();
  return <SettingsPane footer={isMobile ? action : undefined}>{body}</SettingsPane>;
}

/**
 * Le chronomètre de la panne, et le compte à rebours de la relecture.
 *
 * Monté avec le voile, démonté avec lui : l'intervalle est effacé dès que le
 * runtime revient, rien ne continue à tourner derrière. La durée part du
 * dernier signe de vie connu du serveur, sinon de l'ouverture du voile.
 * `role="timer"` n'est pas une région vive : le lecteur d'écran n'annonce pas
 * chaque seconde.
 */
function RuntimeOfflineClock({ offline }: { offline: RuntimeOffline }) {
  const { t } = useT();
  const [openedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);
  const serverSince = offline.since ? Date.parse(offline.since) : Number.NaN;
  // `min` : une horloge serveur en avance ne doit pas faire partir la durée du futur.
  const since = Number.isFinite(serverSince) ? Math.min(serverSince, openedAt) : openedAt;
  const remaining = Math.ceil((offline.lastAttemptAt + RUNTIME_POLL_MS - now) / 1000);
  // Échéance passée sans requête en vol (onglet en arrière-plan) : on attend la relecture.
  const checking = offline.checking || remaining <= 0;
  const total = Math.max(0, Math.floor((now - since) / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const pad = (value: number) => String(value).padStart(2, "0");
  const clock = `${days > 0 || hours > 0 ? `${pad(hours)}:` : ""}${pad(Math.floor((total % 3_600) / 60))}:${pad(total % 60)}`;
  return (
    <div role="timer" className="mt-5 rounded-xl border border-border bg-surface-sunken px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-muted-foreground">{t("modelsSettings.offlineSince")}</span>
        <span className="text-2xl font-semibold tabular-nums tracking-tight">
          {days > 0 ? `${t("modelsSettings.offlineDays", { days })} ` : ""}{clock}
        </span>
      </div>
      <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
        <DotMatrix
          state={checking ? "syncing" : "waiting"}
          label={t(checking ? "modelsSettings.offlineChecking" : "modelsSettings.offlineWaiting")}
          className="size-4"
        />
        {checking ? t("modelsSettings.offlineChecking") : t("modelsSettings.offlineNextCheck", { seconds: remaining })}
      </p>
    </div>
  );
}
