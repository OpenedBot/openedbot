import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import { RiAddFill, RiSearchLine } from "@remixicon/react";
import { cn } from "@openedbot/browser-ui-kit";
import { useT } from "../../lib/i18n";
import { BuiCloseGlyph } from "./menu";
import { RailLogo } from "./board-rails";

/**
 * Variant C: the conversations card's head row (since 09-11-2026). The logo
 * (web) or the traffic lights' room (macOS), then search as a magnifier that
 * unfolds into the field (on click or focus, the width opens) and the « + »,
 * which leads to creating a bot (`useNewBot`) without the bot / group-chat
 * menu. A window drag handle in the desktop app. The search state stays in
 * `BoardSidebar`, which filters the roster with it.
 */
export function RailCardHead({ searchShown, inputRef, query, hasQuery, onQuery, onKeyDown, onOpenChange, onCloseSearch, onCreate }: {
  searchShown: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  hasQuery: boolean;
  onQuery: (query: string) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  onOpenChange: (open: boolean) => void;
  onCloseSearch: () => void;
  onCreate: () => void;
}) {
  const { t } = useT();
  return (
    <div data-rail-head="" data-sidebar-tools="" data-titlebar-drag="" className="mb-1.5 flex h-9 shrink-0 items-center gap-1.5">
      <RailLogo />
      <div className="flex min-w-0 flex-1 justify-end">
        {/* On focus, the composer's treatment (DESIGN.md): the field lightens,
            a thin border and a light shadow, no form ring. */}
        <label
          data-rail-search={searchShown ? "open" : "closed"}
          title={searchShown ? undefined : t("appSidebar.searchAriaLabel")}
          className={cn(
            "flex h-8 min-w-0 items-center overflow-hidden border border-transparent bg-background-tertiary-default text-foreground-icon-tertiary transition-[width,border-radius,padding,border-color,box-shadow,background-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
            searchShown
              ? "w-full cursor-text gap-1.5 rounded-lg ps-2.5 pe-2 focus-within:border-composer-edge-hover focus-within:bg-background-primary-default focus-within:shadow-xs"
              : "w-8 cursor-pointer justify-center rounded-full text-foreground-icon-secondary hover:bg-background-tertiary-hover hover:text-text-primary",
          )}
        >
          {/* Closed, no gap: the empty input would push the glass 3 px off-centre. */}
          <RiSearchLine aria-hidden className={cn("shrink-0", searchShown ? "size-4" : "size-[18px]")} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => onOpenChange(true)}
            onBlur={() => {
              if (!hasQuery) onOpenChange(false);
            }}
            aria-label={t("appSidebar.searchAriaLabel")}
            placeholder={t("boardui.searchPlaceholder")}
            className={cn(
              "m-0 min-w-0 border-0 bg-transparent p-0 text-left font-sans text-body-2-medium text-text-primary outline-none placeholder:text-text-tertiary",
              searchShown ? "flex-1" : "w-0 flex-none opacity-0",
            )}
          />
          {hasQuery ? (
            <button
              type="button"
              aria-label={t("boardui.closeSearch")}
              onClick={onCloseSearch}
              className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-foreground-icon-secondary outline-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
            >
              <BuiCloseGlyph />
            </button>
          ) : null}
        </label>
      </div>
      {/* Variant C: the « + » leads to creating a bot (`useNewBot`),
          without the bot / group-chat menu. */}
      <button
        type="button"
        aria-label={t("boardui.createBot")}
        title={t("boardui.createBot")}
        onClick={onCreate}
        className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-background-tertiary-default text-foreground-icon-secondary hover:bg-background-tertiary-hover hover:text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <RiAddFill className="size-[18px]" />
      </button>
    </div>
  );
}
