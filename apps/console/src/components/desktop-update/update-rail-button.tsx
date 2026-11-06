import { useLayoutEffect, useRef, type ReactNode } from "react";
import { RiDownloadCloud2Line, RiLoader4Line } from "@remixicon/react";
import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@openedbot/browser-ui-kit";
import { useT } from "../../lib/i18n";
import { useNativeUpdateState } from "../../lib/platform/native-updates";
import { openUpdateDialog } from "./update-hooks";
import { pillView } from "./update-model";

/**
 * Sa place dans le rail : 36 px plus l'écart de 6 px du rail. Elle s'ouvre
 * (hauteur, écart, fondu) au lieu de pousser d'un coup les icônes au-dessus ;
 * aucune place tant que le bouton est absent. Animée par le script et non par
 * une feuille de style, pour que le build web n'en garde rien. Sans masque de
 * débordement : l'anneau de focus reste entier.
 */
function RailSlot({ children }: { children: ReactNode }) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = slot.current;
    if (!element?.animate || globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const animation = element.animate(
      [
        { height: "0px", marginTop: "-6px", opacity: 0, transform: "scale(0.6)" },
        { height: "36px", marginTop: "0px", opacity: 1, transform: "none" },
      ],
      { duration: 240, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
    return () => animation.cancel();
  }, []);
  return <div ref={slot} data-rail-update-slot="" className="h-9 shrink-0">{children}</div>;
}

/** La taille et la cible des autres boutons du rail (`RAIL_BUTTON`, board-rails.tsx). */
const RAIL_SQUARE =
  "relative inline-flex size-9 shrink-0 items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-update-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background-full [&>svg]:size-[18px]";

/**
 * La mise à jour dans le rail d'icônes (disposition « c »), juste au-dessus
 * de Réglages : le rail n'a pas de pied de barre où poser la pastille. Même
 * état et mêmes règles que la pastille (`pillView`) : rien au repos ni en
 * erreur, un anneau pendant le téléchargement, un carré plein du bleu de
 * mise à jour (`--update-accent`, le systemBlue d'Apple, icône blanche ;
 * jamais `--primary`) une fois prête, dont le clic ouvre le
 * dialogue « Mise à jour prête ». Absent, il ne réserve aucune place ; il
 * entre en ouvrant sa place (`RailSlot`).
 */
export function UpdateRailButton() {
  const { t } = useT();
  const view = pillView(useNativeUpdateState());
  if (view.kind === "hidden") return null;
  if (view.kind === "downloading") {
    const label = view.percent === null ? t("desktopUpdate.downloadingTooltipNoTotal") : t("desktopUpdate.downloadingTooltip", { percent: view.percent });
    return (
      <RailSlot>
        <Tooltip>
          <TooltipTrigger asChild>
            <span role="status" aria-label={label} data-desktop-update-rail="downloading" className={cn(RAIL_SQUARE, "text-update-accent")}>
              <RiLoader4Line aria-hidden className="animate-spin motion-reduce:animate-none" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      </RailSlot>
    );
  }
  const label = t("desktopUpdate.railTooltip", { version: view.version });
  return (
    <RailSlot>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            data-desktop-update-rail="ready"
            onClick={() => openUpdateDialog(view.version)}
            className={cn(
              RAIL_SQUARE,
              "cursor-pointer bg-update-accent text-update-accent-contrast transition-colors duration-150 hover:bg-update-accent-hover motion-reduce:transition-none",
            )}
          >
            <RiDownloadCloud2Line aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    </RailSlot>
  );
}
