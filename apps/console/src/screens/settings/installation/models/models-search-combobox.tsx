import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconChevronDown } from "@tabler/icons-react";
import { cn, Command, CommandEmpty, CommandInput, CommandList } from "@openedbot/browser-ui-kit";

/**
 * Le champ à liste filtrable des réglages Modèles (fournisseur, modèle) : un
 * déclencheur de la hauteur d'un `Select`, et sous lui une liste cmdk avec sa
 * recherche. Le panneau est portalé sur `document.body` en `position: fixed`
 * (z-[115], au-dessus de l'overlay Dialog z-[110]), comme `SelectContent`,
 * ancré au rect du déclencheur et repositionné au resize / scroll. Escape est
 * arrêté en phase capture pour ne fermer ni une Dialog ni la modale parente.
 *
 * `children` reçoit `pick`, qui ferme puis transmet le choix : ce sont des
 * `CommandGroup` / `CommandItem` posés par l'appelant.
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
  /** La police du libellé (`font-mono` pour un id de modèle). */
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
    const spaceBelow = vh - rect.bottom;
    const spaceAbove = rect.top;
    if (spaceBelow >= 320 || spaceBelow >= spaceAbove) {
      setPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    } else {
      setPos({ bottom: vh - rect.top + 4, left: rect.left, width: rect.width });
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
