import { RiDownloadCloud2Line, RiLoader4Line } from "@remixicon/react";
import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@openedbot/browser-ui-kit";
import { useT } from "../../lib/i18n";
import { useNativeUpdateState } from "../../lib/platform/native-updates";
import { openUpdateDialog } from "./update-hooks";
import { menuRowVersion, pillView } from "./update-model";

/**
 * The update pill, at the foot of the bar next to the account (the reference app,
 * `sand-update-pill`). FIXED update blue, solid with white on it
 * (`--update-accent`, Apple's systemBlue), never `--primary` which follows
 * the bot's or the space's accent.
 * No animation once ready; during the download, a ring that
 * spins and the percentage in a tooltip. The click opens the dialog, never
 * a direct restart.
 */
export function UpdatePill() {
  const { t } = useT();
  const view = pillView(useNativeUpdateState());
  if (view.kind === "hidden") return null;
  if (view.kind === "downloading") {
    const label = view.percent === null ? t("desktopUpdate.downloadingTooltipNoTotal") : t("desktopUpdate.downloadingTooltip", { percent: view.percent });
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span role="status" aria-label={label} data-desktop-update-pill="downloading" className="inline-flex size-[30px] shrink-0 items-center justify-center text-update-accent">
            <RiLoader4Line aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>
    );
  }
  const tooltip = t("desktopUpdate.pillTooltip", { version: view.version });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-desktop-update-pill="ready"
          onClick={() => openUpdateDialog(view.version)}
          className={cn(
            "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2.5 text-[12px] leading-4 font-semibold whitespace-nowrap outline-none",
            "bg-update-accent text-update-accent-contrast transition-colors hover:bg-update-accent-hover focus-visible:ring-2 focus-visible:ring-update-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background-full",
          )}
        >
          <RiDownloadCloud2Line aria-hidden className="size-3.5" />
          {t("desktopUpdate.pill")}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/** The account menu row (the reference app: « New update available » + Install). */
export function UpdateMenuRow({ onSelect, mobileDrawer }: { onSelect: () => void; mobileDrawer: boolean }) {
  const { t } = useT();
  const version = menuRowVersion(useNativeUpdateState());
  if (!version) return null;
  return (
    <div data-desktop-update-row="" className={cn("flex w-full items-center justify-between gap-2.5 rounded-2lg px-2 py-1", mobileDrawer && "min-h-11")}>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <RiDownloadCloud2Line aria-hidden className="size-5 shrink-0 text-update-accent" />
        <span className="truncate text-body-medium text-text-primary">{t("desktopUpdate.menuRow")}</span>
      </span>
      <button
        type="button"
        data-closes-drawer=""
        onClick={() => {
          onSelect();
          openUpdateDialog(version);
        }}
        className="inline-flex h-6 shrink-0 cursor-pointer items-center rounded-full bg-update-accent px-2 text-xs font-semibold text-update-accent-contrast outline-none transition-colors hover:bg-update-accent-hover focus-visible:ring-2 focus-visible:ring-update-accent focus-visible:ring-offset-2"
      >
        {t("desktopUpdate.menuInstall")}
      </button>
    </div>
  );
}
