import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconChevronDown } from "@tabler/icons-react";
import { cn, Command, CommandEmpty, CommandInput, CommandList } from "@openedbot/browser-ui-kit";

/** The panel's floor, in px: a provider's name and Hermes' reason fit on their line. */
const PANEL_MIN_WIDTH = 448;
/** Distance kept between the panel and the window's edges, in px. */
const VIEWPORT_MARGIN = 8;
/** The closed field, and in `inline` mode the open one: a `Select`'s box. */
const FIELD_BOX =
  "flex h-11 w-full items-center gap-2 rounded-[10px] border border-input bg-card px-3 text-sm text-foreground shadow-[var(--shadow-xs)] transition-colors outline-none";

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
 *
 * `inline`: the search takes the field's place on click (no second box), and
 * the list drops exactly under it, same left edge and same width. For a field
 * that owns its column (the onboarding); a settings row keeps the wide panel.
 */
export function SearchCombobox({
  id,
  triggerLabel,
  triggerClassName,
  disabled,
  searchPlaceholder,
  emptyText,
  inline = false,
  children,
}: {
  id: string;
  triggerLabel: ReactNode;
  /** The label's font (`font-mono` for a model id). */
  triggerClassName?: string;
  disabled?: boolean;
  searchPlaceholder: string;
  emptyText: string;
  inline?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; width: number }>({
    left: 0,
    width: 0,
  });

  const buttonRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    // The inline search replaced the field: give it its focus back.
    if (inline) requestAnimationFrame(() => buttonRef.current?.focus());
  };

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
    const width = inline ? rect.width : Math.min(Math.max(rect.width, PANEL_MIN_WIDTH), vw - 2 * VIEWPORT_MARGIN);
    const left = inline ? rect.left : Math.min(
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
      setOpen(false);
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

  const chevron = (
    <IconChevronDown
      aria-hidden
      className={cn(
        "size-4 shrink-0 text-muted-foreground/70 transition-transform duration-200",
        open && "rotate-180",
      )}
    />
  );
  const list = (
    <CommandList scrollbar="subtle" className={inline ? "max-h-72" : "mt-2 max-h-60 pr-1 md:max-h-80"}>
      <CommandEmpty>{emptyText}</CommandEmpty>
      {children(close)}
    </CommandList>
  );
  const panel = (content: ReactNode) => createPortal(
    <div
      ref={panelRef}
      style={{ position: "fixed", top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width }}
      className="z-[115]"
      data-portal-panel=""
      onKeyDown={stopEscape}
    >
      {content}
    </div>,
    document.body,
  );

  if (inline && open) {
    // ONE cmdk root for the field and its list: the list is portaled, but
    // stays in the root's React tree, so arrows and Enter drive it from the input.
    return (
      <div ref={rootRef} className={cn(FIELD_BOX, "border-ring ring-2 ring-ring/20")}>
        <Command
          className={cn(
            "flex-row items-center gap-2 overflow-visible rounded-none! bg-transparent p-0",
            "[&_[data-slot=command-input-wrapper]]:h-full [&_[data-slot=command-input-wrapper]]:flex-1 [&_[data-slot=command-input-wrapper]]:gap-2.5 [&_[data-slot=command-input-wrapper]]:border-0 [&_[data-slot=command-input-wrapper]]:bg-transparent [&_[data-slot=command-input-wrapper]]:px-0",
            "[&_[data-slot=command-input]]:min-h-0 [&_[data-slot=command-input]]:text-sm",
          )}
          onKeyDown={stopEscape}
        >
          <CommandInput autoFocus aria-controls={`${id}-list`} placeholder={searchPlaceholder} onKeyDown={stopEscape} />
          {chevron}
          {panel(
            <div id={`${id}-list`} className="overflow-hidden rounded-[12px] border border-border/70 bg-card p-1.5 shadow-[var(--shadow-elevated)]">
              {list}
            </div>,
          )}
        </Command>
      </div>
    );
  }

  return (
    <div ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          FIELD_BOX,
          "justify-between select-none",
          "hover:border-border focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20",
          "disabled:cursor-not-allowed disabled:bg-surface disabled:text-muted-foreground disabled:[-webkit-text-fill-color:currentColor]",
        )}
      >
        <span className={cn("min-w-0 flex-1 truncate text-left whitespace-nowrap", triggerClassName)}>{triggerLabel}</span>
        {chevron}
      </button>
      {open
        ? panel(
            <Command
              className="h-auto overflow-hidden rounded-lg border border-border bg-card p-2 shadow-[var(--shadow-elevated)]"
              onKeyDown={stopEscape}
            >
              <CommandInput placeholder={searchPlaceholder} onKeyDown={stopEscape} />
              {list}
            </Command>,
          )
        : null}
    </div>
  );
}
