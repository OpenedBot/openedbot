import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RiFlashlightFill } from "@remixicon/react";
import type { YoloScope } from "@openedbot/contracts-api";
import { cn } from "@openedbot/browser-ui-kit";
import { formatCountdown, useCountdown } from "../../lib/countdown";
import { useT } from "../../lib/i18n";
import { invalidateYolo } from "./yolo-shared";

/**
 * « YOLO » et le temps qui reste, partout où le mode du bot se lit. Le
 * compte à rebours part de `expiresAt` publié par le serveur, jamais d'une
 * durée comptée ici. À l'échéance le badge disparaît et les baux se
 * relisent : l'hôte a déjà repris la main de lui-même.
 *
 * `onOpen` : le badge est un bouton qui ouvre la fiche du bot ; sans lui, une
 * simple étiquette.
 */
export function YoloBadge({
  leaseId,
  expiresAt,
  scope,
  onOpen,
  compact = false,
  className,
}: {
  leaseId: string;
  expiresAt: string;
  scope: YoloScope;
  onOpen?: () => void;
  /** La ligne de sous-titre de l'en-tête téléphone. */
  compact?: boolean;
  className?: string;
}) {
  const { t, formatDate } = useT();
  const queryClient = useQueryClient();
  const { remainingMs } = useCountdown(expiresAt);
  const expired = remainingMs <= 0;
  // Une seule relecture par bail échu : si le serveur le rend encore (horloge
  // en retard), le badge reste masqué sans relancer de requête à chaque rendu.
  const refreshed = useRef<string | null>(null);
  useEffect(() => {
    if (!expired || refreshed.current === leaseId) return;
    refreshed.current = leaseId;
    void invalidateYolo(queryClient);
  }, [expired, leaseId, queryClient]);
  if (expired) return null;

  const time = formatCountdown(remainingMs);
  const hint = t("yolo.badgeHint", { scope: t(`yolo.scope.${scope}`), date: formatDate(expiresAt) });
  const content = (
    <>
      {compact ? <span aria-hidden>·</span> : null}
      <RiFlashlightFill aria-hidden className={cn("shrink-0", compact ? "size-3.5" : "size-4")} />
      <span className="whitespace-nowrap font-semibold">{t("yolo.badge")}</span>
      <span data-yolo-countdown="" className="whitespace-nowrap tabular-nums">{time}</span>
    </>
  );
  // Pas de région live : un compte à rebours annoncé à chaque seconde serait
  // un bruit continu. Le bouton porte son nom complet ; l'étiquette, une
  // phrase pour les lecteurs d'écran.
  const shared = {
    "data-yolo-badge": scope,
    title: hint,
    className: cn(
      "flex shrink-0 items-center gap-1 rounded-full outline-none",
      compact
        ? "min-w-0 text-[13px] leading-4 text-warn-700"
        : "h-7 border border-warn-700/40 bg-warn-soft ps-2 pe-2.5 text-body-2-medium text-warn-700",
      onOpen && "cursor-pointer transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-border-focus-ring",
      className,
    ),
  };
  const label = t("yolo.badgeAria", { scope: t(`yolo.scope.${scope}`), time, hint });
  return onOpen
    ? <button type="button" onClick={onOpen} aria-label={label} {...shared}>{content}</button>
    : <span {...shared}><span aria-hidden className="contents">{content}</span><span className="sr-only">{label}</span></span>;
}
