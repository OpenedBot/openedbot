import { useState } from "react";
import { type QueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { Dialog, cn } from "@openedbot/browser-ui-kit";
import { api, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { ProviderIcon } from "../provider-icon";
import { ProviderLimitsPanel, providerLimitsAlerting, useProviderLimits } from "./provider-limits-panel";
import { BUTTON } from "../settings/primitives";

/**
 * Relit les limites par une sonde forcée et les pose dans le cache : à jouer
 * après un accès fournisseur posé ou renouvelé, sinon la carte garde le
 * relevé d'avant jusqu'à deux minutes (mesuré le 05-09 sur openai-codex).
 */
export async function refreshProviderLimits(queryClient: QueryClient, runtimeId: string): Promise<void> {
  try {
    const data = await api.runtimeProviderUsage(runtimeId, true);
    queryClient.setQueryData(queryKeys.runtimeProviderUsage(runtimeId), data);
  } catch {
    await queryClient.invalidateQueries({ queryKey: queryKeys.runtimeProviderUsage(runtimeId) });
  }
}

/**
 * L'alerte de quota du pied de la barre latérale.
 *
 * Elle ne se montre que lorsqu'il y a quelque chose à faire : le mur approche,
 * ou le relevé ne se lit plus (`providerLimitsAlerting`). Le relevé complet,
 * lui, vit en permanence dans l'onglet du composer, au-dessus du champ où l'on
 * décide de dépenser. Un quota hebdomadaire bouge lentement : lui donner un
 * emplacement fixe apprenait surtout à ignorer la zone, et le jour où le
 * nombre comptait il se lisait comme les six jours où il ne comptait pas.
 */
export function ProviderLimitsCard({ compact = false }: { compact?: boolean }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const limits = useProviderLimits(open);

  if (!limits.canView || limits.runtimeId === null) return null;
  // Muet tant que la lecture n'a pas eu lieu : une pastille qui apparaît puis
  // s'efface est pire que le silence pour une alerte.
  if (limits.pending || (limits.providers.length === 0 && !limits.readFailed)) return null;
  // `open` retient la carte : une relecture qui repasse sous le seuil ferait
  // sinon disparaître la modale sous le doigt de qui vient de l'ouvrir.
  if (!open && !providerLimitsAlerting(limits)) return null;

  // Le chiffre de la pastille est celui qui l'a allumée : le pic des
  // fournisseurs EN SERVICE. Afficher le pic global ferait lire « 100 % » à
  // cause d'un compte que plus aucun bot n'utilise.
  const peakLabel = limits.servicePeak === null
    ? t("providerLimits.unavailable")
    : t("providerLimits.peak", { percent: Math.round(limits.servicePeak) });
  // Seuls les fournisseurs qui portent un relevé entrent dans la pastille :
  // une icône « non mesurable » n'ajoute rien à une alerte.
  const marks = limits.providers.filter((provider) => {
    const snapshot = limits.snapshots.get(provider.slug);
    return snapshot !== undefined && snapshot.windows.some((window) => window.usedPercent !== null);
  });
  const extraMarks = Math.max(0, marks.length - 3);

  return (
    <>
      {/* Le pic est le seul chiffre de la carte : il entre dans le nom
          accessible, sinon un lecteur d'écran ne l'entend jamais. */}
      <button
        type="button"
        data-provider-limits=""
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${t("providerLimits.open")} · ${peakLabel}`}
        onClick={() => setOpen(true)}
        className={cn(
          "ohb-press mb-2 flex min-h-11 w-full items-center gap-2 rounded-xl border border-warn-100 bg-warn-soft px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring",
          compact && "mx-0",
        )}
      >
        <span className="shrink-0 text-xs font-semibold tracking-wide text-sidebar-foreground">{t("providerLimits.title")}</span>
        <span className="flex min-w-0 flex-1 items-center justify-center gap-1">
          {marks.slice(0, 3).map((provider) => (
            <ProviderIcon key={provider.slug} provider={provider.slug} name={provider.name} decorative className="size-5" />
          ))}
          {extraMarks > 0 ? <span className="text-[10px] text-sidebar-muted-foreground">+{extraMarks}</span> : null}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground">{peakLabel}</span>
        <ChevronRight className="size-4 shrink-0 text-sidebar-muted-foreground" aria-hidden />
      </button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("providerLimits.title")}
        description={t("providerLimits.subtitle")}
        closeLabel={t("providerLimits.close")}
        bodyClassName="px-5 pt-2 pb-5"
        footer={
          // Rien à confirmer ici : la modale se lit. Le bleu de marque irait à
          // l'action la moins importante de l'écran.
          <button
            type="button"
            onClick={() => setOpen(false)}
            className={`${BUTTON.secondary} w-full sm:w-auto`}
          >
            {t("providerLimits.close")}
          </button>
        }
      >
        <ProviderLimitsPanel limits={limits} onNavigate={() => setOpen(false)} />
      </Dialog>
    </>
  );
}
