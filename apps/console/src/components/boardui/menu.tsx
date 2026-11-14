import type { ComponentProps, ComponentType, ReactNode } from "react";
import { ContextMenu, Popover } from "radix-ui";
import { cn } from "@openedbot/browser-ui-kit";

/**
 * The floating surfaces of the BoardUI « Multi-agent Chat » template: a
 * white panel with a 20 px radius, 6 px of padding, a #ebebeb hairline and a
 * `dropdown` shadow, which enters with a fade + 95% zoom + 2 px blur.
 *
 * They wrap the Radix primitives the console already uses: the
 * keyboard, the focus and the dismissal stay Radix's, only the skin is
 * the template's.
 */
export const BUI_POPOVER =
  "bui-popover bui-scroll z-50 flex max-h-[min(var(--radix-popper-available-height,828px),828px)] max-w-[calc(100vw-32px)] flex-col overflow-y-auto rounded-[20px] border border-border-button-default bg-background-primary-default p-1.5 text-text-primary shadow-dropdown outline-none";

/** A menu row: 36 px, a 20 px grey icon. The hover is `dropdown-item-hover` (light #f7f7f7, dark one step above the panel). */
export const BUI_MENU_ITEM =
  "openedbot-row flex w-full cursor-pointer select-none items-center gap-2 rounded-2lg px-2 py-1.5 text-start text-body-medium text-text-primary outline-none hover:bg-dropdown-item-hover-background focus-visible:bg-dropdown-item-hover-background data-[highlighted]:bg-dropdown-item-hover-background data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50";

/** A panel row (« + » menus, account): hover via the primary surface. */
export const BUI_PANEL_ITEM =
  "openedbot-row flex w-full cursor-pointer items-center gap-2 rounded-2lg px-2 py-1.5 text-start outline-none hover:bg-background-primary-hover focus-visible:bg-background-primary-hover data-[highlighted]:bg-background-primary-hover disabled:cursor-not-allowed disabled:opacity-50";

export const BUI_MENU_ICON = "size-5 shrink-0 text-foreground-icon-secondary";

type IconType = ComponentType<{ className?: string }>;

export function BuiSectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("ps-2 text-body-medium text-text-secondary", className)}>{children}</span>;
}

/* --- Menu contextuel (clic droit / appui long) --------------------------- */

export const BuiContextMenu = ContextMenu.Root;
export const BuiContextMenuTrigger = ContextMenu.Trigger;

export function BuiContextMenuContent({ className, children, ...props }: ComponentProps<typeof ContextMenu.Content>) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.Content className={cn(BUI_POPOVER, "min-w-[198px] gap-1", className)} {...props}>
        {children}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  );
}

export function BuiContextMenuItem({
  icon: Icon,
  leading,
  destructive,
  className,
  children,
  ...props
}: ComponentProps<typeof ContextMenu.Item> & { icon?: IconType; leading?: ReactNode; destructive?: boolean }) {
  return (
    <ContextMenu.Item className={cn(BUI_MENU_ITEM, destructive && "text-text-destructive", className)} {...props}>
      {leading ?? (Icon ? <Icon className={cn("size-5 shrink-0", destructive ? undefined : "text-foreground-icon-secondary")} /> : null)}
      {children}
    </ContextMenu.Item>
  );
}

export const BuiContextSub = ContextMenu.Sub;

export function BuiContextSubTrigger({ icon: Icon, className, children, ...props }: ComponentProps<typeof ContextMenu.SubTrigger> & { icon?: IconType }) {
  return (
    <ContextMenu.SubTrigger className={cn(BUI_MENU_ITEM, "data-[state=open]:bg-dropdown-item-hover-background", className)} {...props}>
      {Icon ? <Icon className={BUI_MENU_ICON} /> : null}
      <span className="flex-1">{children}</span>
      <svg viewBox="0 0 24 24" aria-hidden className="size-4 shrink-0 text-foreground-icon-tertiary" fill="currentColor">
        <path d="M13.1717 12.0007L8.22192 7.05093L9.63614 5.63672L16.0001 12.0007L9.63614 18.3646L8.22192 16.9504L13.1717 12.0007Z" />
      </svg>
    </ContextMenu.SubTrigger>
  );
}

export function BuiContextSubContent({ className, children, ...props }: ComponentProps<typeof ContextMenu.SubContent>) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.SubContent className={cn(BUI_POPOVER, "min-w-[198px] gap-1", className)} sideOffset={6} {...props}>
        {children}
      </ContextMenu.SubContent>
    </ContextMenu.Portal>
  );
}

/* --- Free popover (rich-content panels) ---------------------------------- */

export const BuiPopover = Popover.Root;
export const BuiPopoverTrigger = Popover.Trigger;

export function BuiPopoverContent({ className, children, sideOffset = 6, ...props }: ComponentProps<typeof Popover.Content>) {
  return (
    <Popover.Portal>
      <Popover.Content sideOffset={sideOffset} className={cn(BUI_POPOVER, className)} {...props}>
        {children}
      </Popover.Content>
    </Popover.Portal>
  );
}

/** The template's round 20 px cross (close search, the editor, a modal). */
export function BuiCloseGlyph() {
  return (
    <svg width="10.8" height="10.8" viewBox="0 0 10.8 10.8" fill="none" aria-hidden>
      <path d="M2 2L8.8 8.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M8.8 2L2 8.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
