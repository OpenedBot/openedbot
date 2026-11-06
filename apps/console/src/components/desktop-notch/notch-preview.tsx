import { useT } from "../../lib/i18n";

/**
 * L'encoche dessinée, quand la démonstration ne peut pas se jouer en haut de
 * l'écran (une encoche trop ancienne, ou qui a échoué) : l'îlot déplié sur
 * une demande d'accord, deux bots au travail. Une image, rien de cliquable.
 * L'îlot reste noir dans les deux thèmes, comme le vrai.
 */
export function NotchPreview() {
  const { t } = useT();
  return (
    <div
      role="img"
      aria-label={t("desktopNotch.previewLabel")}
      data-notch-preview=""
      className="relative h-40 overflow-hidden rounded-xl border border-border bg-gradient-to-b from-muted to-background"
    >
      <div aria-hidden className="absolute inset-x-0 top-0 h-5 bg-foreground/5" />
      <div aria-hidden className="absolute left-1/2 top-0 w-72 -translate-x-1/2 rounded-b-[22px] bg-black px-4 pb-3 pt-2 text-[11px] text-white shadow-lg">
        <div className="flex items-center justify-between">
          <div className="flex -space-x-1.5">
            <span className="grid size-5 place-items-center rounded-full bg-sky-500 text-[9px] font-semibold ring-2 ring-black">{t("desktopNotch.previewResearch").slice(0, 1)}</span>
            <span className="grid size-5 place-items-center rounded-full bg-amber-500 text-[9px] font-semibold ring-2 ring-black">{t("desktopNotch.previewWriting").slice(0, 1)}</span>
          </div>
          <span className="h-4 w-16 rounded-full bg-neutral-900" />
          <span className="flex items-center gap-1.5 text-white/70">
            <span className="size-1.5 rounded-full bg-amber-400" />
            {t("desktopNotch.previewWorking")}
          </span>
        </div>
        <div className="mt-3 rounded-xl bg-white/10 px-3 py-2">
          <p className="font-semibold">{t("desktopNotch.previewWaiting")}</p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-white/60">{t("desktopNotch.previewCommand")}</p>
          <div className="mt-2 flex justify-end gap-2">
            <span className="rounded-full bg-red-500/20 px-3 py-1 text-red-300">{t("desktopNotch.previewDeny")}</span>
            <span className="rounded-full bg-emerald-500 px-3 py-1 font-semibold text-black">{t("desktopNotch.previewAllow")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
