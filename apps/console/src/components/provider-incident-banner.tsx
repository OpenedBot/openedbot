import { createContext, useContext, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { RuntimeProviderIncidentDto } from "@openedbot/contracts-api";
import { Dialog } from "@openedbot/browser-ui-kit";
import { useT } from "../lib/i18n";
import { BUTTON, Note } from "./settings/primitives";

/**
 * Une panne fournisseur s'annonce au milieu de la page, sur un fond flouté.
 * « Plus tard » la range pour cet affichage seulement : chaque chargement de
 * l'écran la rouvre tant que la panne dure, et un nouvel échec (qui avance
 * `lastSeenAt`) aussi. La boîte reste montée pour jouer sa sortie.
 */
export function ProviderIncidentDialog({
  incidents,
  onReconnect,
}: {
  incidents: readonly RuntimeProviderIncidentDto[] | null | undefined;
  /** Sur l'écran Modèles, « Reconnecter » ouvre l'onglet des accès au lieu de renaviguer vers lui-même. */
  onReconnect?: () => void;
}) {
  const { t, locale } = useT();
  const active = (incidents ?? []).filter((incident) => new Date(incident.until).getTime() > Date.now());
  const signature = active.map((incident) => `${incident.kind}:${incident.provider}:${incident.lastSeenAt}`).join("|");
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (active.length === 0) return null;
  const dismiss = () => setDismissed(signature);
  return (
    <Dialog
      open={dismissed !== signature}
      onClose={dismiss}
      role="alertdialog"
      title={t("providerIncidents.title")}
      closeLabel={t("common.close")}
      overlayClassName="backdrop-blur-sm"
      footer={(
        <>
          <button type="button" className={BUTTON.secondary} onClick={dismiss}>
            {t("providerIncidents.later")}
          </button>
          {onReconnect ? (
            <button type="button" className={BUTTON.primary} onClick={() => { dismiss(); onReconnect(); }}>
              {t("providerIncidents.reconnect")}
            </button>
          ) : (
            <Link to="/settings/models" className={BUTTON.primary} onClick={dismiss}>
              {t("providerIncidents.reconnect")}
            </Link>
          )}
        </>
      )}
    >
      <div className="flex flex-col gap-2">
        {active.map((incident) => {
          const time = formatIncidentTime(incident.lastSeenAt, locale);
          const fallback = incident.fallbackProvider && incident.fallbackModel
            ? `${incident.fallbackProvider} / ${incident.fallbackModel}`
            : null;
          const key = incident.kind === "quota"
            ? (fallback ? "providerIncidents.quotaReached" : "providerIncidents.quotaReachedNoFallback")
            : (fallback ? "providerIncidents.authLost" : "providerIncidents.authLostNoFallback");
          return (
            <Note key={`${incident.kind}:${incident.provider}`} tone="warning" role="alert">
              {t(key, { provider: incident.provider, time, fallback: fallback ?? "" })}
            </Note>
          );
        })}
      </div>
    </Dialog>
  );
}

/**
 * Les incidents du runtime affiché, pour les badges d'accès de l'annuaire des
 * fournisseurs : sans eux, un credential révoqué s'y lit « accès détecté ».
 */
export const ProviderIncidentsContext = createContext<readonly RuntimeProviderIncidentDto[]>([]);

/** L'incident en cours sur ce fournisseur, lu dans le contexte de l'écran. */
export function useProviderIncident(provider: string): RuntimeProviderIncidentDto | null {
  return activeProviderIncident(useContext(ProviderIncidentsContext), provider);
}

/** L'incident en cours sur le fournisseur qu'un run utilisera, s'il y en a un. */
export function activeProviderIncident(
  incidents: readonly RuntimeProviderIncidentDto[] | null | undefined,
  provider: string | null | undefined,
): RuntimeProviderIncidentDto | null {
  if (!provider) return null;
  return (incidents ?? []).find(
    (incident) => incident.provider === provider && new Date(incident.until).getTime() > Date.now(),
  ) ?? null;
}

function formatIncidentTime(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return iso;
  return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
