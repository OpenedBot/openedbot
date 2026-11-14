import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconChevronDown } from "@tabler/icons-react";
import { cn, Command, CommandEmpty, CommandInput, CommandList } from "@openedbot/browser-ui-kit";

/** The panel's floor, in px: a provider's name and Hermes' reason fit on their line. */
const PANEL_MIN_WIDTH = 448;
/** Distance kept between the panel and the window's edges, in px. */
const VIEWPORT_MARGIN = 8;

/**
 * The filterable list field of the Models settings (provider, model): a
 * trigger the height of a `Select`, and under it a cmdk list with its
 * search. The panel is portaled onto `document.body` in `position: fixed`
 * (z-[115], above the Dialog overlay z-[110]), like `SelectContent`,
 * anchored to the trigger's rect and repositioned on resize / scroll. Escape is
 * stopped in the capture phase so it closes neither a Dialog nor the parent modal.
 *
 * `children` receives `pick`, which closes then forwards the choice: these are
 * `CommandGroup` / `CommandItem` placed by the caller.
 */
export function SearchCombobox({
  id,
  triggerLabel,
  triggerClassName,
  disabled,
  searchPlaceholder,
  emptyText,
  children,
}: {
  id: string;
  triggerLabel: ReactNode;
  /** The label's font (`font-mono` for a model id). */
  triggerClassName?: string;
  disabled?: boolean;
  searchPlaceholder: string;
  emptyText: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; width: number }>({
    left: 0,
    width: 0,
  });

  const close = () => setOpen(false);

  const stopEscape = (event: { key: string; preventDefault: () => void; stopPropagation: () => void }) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  const place = () => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const vh = document.documentElement.clientHeight;
    const vw = document.documentElement.clientWidth;
    // The trigger sits on the right of a settings row (18 rem): its own width
    // cut every provider name and Hermes' reason. The panel is at least
    // PANEL_MIN_WIDTH, grows to the left from the trigger's right edge (where
    // the eye already is), and never leaves the window.
    const width = Math.min(Math.max(rect.width, PANEL_MIN_WIDTH), vw - 2 * VIEWPORT_MARGIN);
    const left = Math.min(
      Math.max(rect.right - width, VIEWPORT_MARGIN),
      vw - VIEWPORT_MARGIN - width,
    );
    const spaceBelow = vh - rect.bottom;
    const spaceAbove = rect.top;
    if (spaceBelow >= 320 || spaceBelow >= spaceAbove) {
      setPos({ top: rect.bottom + 4, left, width });
    } else {
      setPos({ bottom: vh - rect.top + 4, left, width });
    }
  };

  useLayoutEffect(() => {
    if (open) place();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      close();
    };
    const onReposition = () => place();
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", onReposition, { capture: true });
    document.addEventListener("scroll", onReposition, { capture: true });
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", onReposition, { capture: true });
      document.removeEventListener("scroll", onReposition, { capture: true });
    };
  }, [open]);

  return (
    <div ref={rootRef}>
      <button
        type="button"
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "flex h-11 w-full items-center justify-between gap-2 rounded-[10px] border border-input bg-card px-3 text-sm text-foreground shadow-[var(--shadow-xs)] transition-colors outline-none select-none",
          "hover:border-border focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20",
          "disabled:cursor-not-allowed disabled:bg-surface disabled:text-muted-foreground disabled:[-webkit-text-fill-color:currentColor]",
        )}
      >
        <span className={cn("min-w-0 flex-1 truncate text-left whitespace-nowrap", triggerClassName)}>{triggerLabel}</span>
        <IconChevronDown
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-muted-foreground/70 transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              style={{ position: "fixed", top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width }}
              className="z-[115]"
              data-portal-panel=""
              onKeyDown={stopEscape}
            >
              <Command
                className="h-auto overflow-hidden rounded-lg border border-border bg-card p-2 shadow-[var(--shadow-elevated)]"
                onKeyDown={stopEscape}
              >
                <CommandInput placeholder={searchPlaceholder} onKeyDown={stopEscape} />
                <CommandList scrollbar="subtle" className="mt-2 max-h-60 pr-1 md:max-h-80">
                  <CommandEmpty>{emptyText}</CommandEmpty>
                  {children(close)}
                </CommandList>
              </Command>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
