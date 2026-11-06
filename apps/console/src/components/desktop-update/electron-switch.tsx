import { RiDownloadCloud2Line } from "@remixicon/react";
import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@openedbot/browser-ui-kit";
import { useT } from "../../lib/i18n";
import { desktopDownloadUrl } from "../../lib/platform/client-update";
import { nativeBridge } from "../../lib/platform";
import { MAC_NATIVE_APP_VERSION, offersMacSwitch } from "../../lib/platform/desktop-switch";
import { openExternal } from "../../lib/platform/open-external";

/**
 * Dans l'app Electron sur Mac, à la place de la pastille de mise à jour
 * qu'elle n'a pas : « Nouvelle app », qui ouvre la page de téléchargement
 * dans le navigateur (la coque Electron y envoie tout `window.open` web).
 * Même bleu informatif que la pastille de l'app native.
 */
export function ElectronMacSwitchPill() {
  const { t, locale } = useT();
  if (!offersMacSwitch(nativeBridge(), navigator)) return null;
  const url = desktopDownloadUrl(locale === "fr" ? "fr" : "en");
  const tooltip = t("desktopSwitch.tooltip", { version: MAC_NATIVE_APP_VERSION });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-desktop-switch-pill=""
          aria-label={tooltip}
          onClick={() => void openExternal(url)}
          className={cn(
            "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2.5 text-[12px] leading-4 font-semibold whitespace-nowrap outline-none",
            "bg-info-soft text-info-700 transition-colors hover:bg-info-100 focus-visible:ring-2 focus-visible:ring-border-focus-ring",
          )}
        >
          <RiDownloadCloud2Line aria-hidden className="size-3.5" />
          {t("desktopSwitch.pill")}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[260px]">{tooltip}</TooltipContent>
    </Tooltip>
  );
}
