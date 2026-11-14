import { useLayoutEffect, useRef, type ReactNode } from "react";
import { RiDownloadCloud2Line, RiLoader4Line } from "@remixicon/react";
import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@openedbot/browser-ui-kit";
import { useT } from "../../lib/i18n";
import { useNativeUpdateState } from "../../lib/platform/native-updates";
import { openUpdateDialog } from "./update-hooks";
import { pillView } from "./update-model";

/**
 * Its place in the foot row: 36 px plus the row's 4 px gap. It opens
 * (width, gap, fade) instead of pushing Settings aside all at once;
 * no place while the button is absent. Animated by script and not by
 * a style sheet, so the web build keeps nothing of it. No overflow
 * mask: the focus ring stays whole.
 */
function RailSlot({ children }: { children: ReactNode }) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = slot.current;
    if (!element?.animate || globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const animation = element.animate(
      [
        { width: "0px", marginInlineStart: "-4px", opacity: 0, transform: "scale(0.6)" },
        { width: "36px", marginInlineStart: "0px", opacity: 1, transform: "none" },
      ],
      { duration: 240, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
    return () => animation.cancel();
  }, []);
  return <div ref={slot} data-rail-update-slot="" className="size-9 shrink-0">{children}</div>;
}

/** The size and the target of the rail's other buttons (`RAIL_BUTTON`, board-rails.tsx). */
const RAIL_SQUARE =
  "relative inline-flex size-9 shrink-0 items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-update-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background-full [&>svg]:size-[18px]";

/**
 * The update in the icon rail (layout « c »), just above
 * Settings: the rail has no foot of the bar to put the pill on. Same
 * state and same rules as the pill (`pillView`): nothing at rest or on
 * error, a ring during the download, a square filled with the update
 * blue (`--update-accent`, Apple's systemBlue, white icon;
 * never `--primary`) once ready, whose click opens the
 * « Mise à jour prête » dialog. Absent, it reserves no place; it
 * enters by opening its place (`RailSlot`).
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
          <TooltipContent side="top">{label}</TooltipContent>
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
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>
    </RailSlot>
  );
}
