import * as React from "react"
import { Select as SelectPrimitive } from "radix-ui"

import { cn } from "../../lib/utils"
import { ChevronDownIcon, CheckIcon, ChevronUpIcon } from "lucide-react"

/**
 * Select: boardui skin.
 *
 * Same shapes as the rest of the design system: `rounded-[10px]` controls with a
 * neutral-200 hairline + `--shadow-xs`, `rounded-2xl` panels on `--shadow-elevated`
 * (see `Popover`, the sidebar menus and the login form), a #3080ff focus ring and
 * the neutral-* text scale. Disabled text must set `-webkit-text-fill-color`
 * (see `app.css`): the UA light-scheme fill otherwise wins in dark mode.
 */

function Select({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />
}

function SelectGroup({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      className={cn("scroll-my-1", className)}
      {...props}
    />
  )
}

function SelectValue({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  /** `default` matches the 44px boardui form controls, `sm` the 36px toolbar controls. */
  size?: "sm" | "default"
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      // height as a plain class (not a data-variant) so callers can override it with `h-auto`
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-[10px] border border-input bg-card px-3 text-sm text-foreground shadow-[var(--shadow-xs)] transition-colors outline-none select-none",
        size === "sm" ? "h-9" : "h-11",
        "hover:border-border",
        "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20",
        "disabled:cursor-not-allowed disabled:bg-surface disabled:text-muted-foreground disabled:[-webkit-text-fill-color:currentColor]",
        "aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20",
        "data-placeholder:text-muted-foreground",
        "*:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="pointer-events-none size-4 shrink-0 text-muted-foreground/70 transition-transform duration-200 in-data-open:rotate-180" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  className,
  children,
  position = "popper",
  side = "bottom",
  sideOffset = 6,
  rows,
  style,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content> & {
  /**
   * Visible rows before the menu scrolls. Item height is `2rem` (`py-1.5` +
   * `text-sm`) plus the `mt-1` gap; panel padding is `p-1.5`.
   */
  rows?: number
}) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        // z-[115] : above the dialog overlay (110), below toasts (120).
        className={cn(
          "scrollbar-subtle relative z-[115] min-w-36 origin-(--radix-select-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-2xl border border-border bg-card p-1.5 text-foreground shadow-[var(--shadow-elevated)] duration-150",
          rows == null
            ? "max-h-(--radix-select-content-available-height)"
            : "max-h-[calc(var(--ohb-select-rows)*2rem+(var(--ohb-select-rows)-1)*0.25rem+0.75rem)]",
          position === "popper" && "w-(--radix-select-trigger-width)",
          "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          "data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1",
          className
        )}
        style={
          rows == null
            ? style
            : ({ ...style, "--ohb-select-rows": String(rows) } as React.CSSProperties)
        }
        position={position}
        side={side}
        sideOffset={position === "popper" ? sideOffset : undefined}
        {...props}
      >
        <SelectScrollUpButton />
        {/* `scroll-py-6` : l'élément choisi, amené en vue à l'ouverture, ne
            finit plus sous la flèche de défilement (24 px) qui le couvrait. */}
        <SelectPrimitive.Viewport
          data-position={position}
          className="scroll-py-6 data-[position=popper]:w-full data-[position=popper]:min-w-(--radix-select-trigger-width)"
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn("px-2 py-1.5 text-xs font-medium text-muted-foreground", className)}
      {...props}
    />
  )
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        // mt-1 keeps two highlighted rows (hover + the checked one) from merging into one grey block
        "relative mt-1 flex w-full cursor-pointer items-center gap-2 rounded-[10px] py-1.5 pr-8 pl-2 text-sm text-foreground/80 outline-hidden transition-colors select-none first:mt-0",
        "hover:bg-accent/60 focus:bg-accent/60 data-[highlighted]:bg-accent/60 data-[state=checked]:bg-muted data-[state=checked]:text-foreground",
        "data-disabled:pointer-events-none data-disabled:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:min-w-0 *:[span]:last:items-center *:[span]:last:gap-2 *:[span]:last:truncate",
        className
      )}
      {...props}
    >
      <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="pointer-events-none size-4 text-primary" strokeWidth={2.5} />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("pointer-events-none -mx-1.5 my-1.5 h-px bg-muted", className)}
      {...props}
    />
  )
}

/**
 * Chevrons de défilement : l'aveu qu'il reste des lignes.
 *
 * Radix ne monte chacune que tant qu'on peut défiler dans SA direction : celle
 * du bas s'efface une fois la liste au bout, celle du haut n'apparaît qu'une
 * fois descendu. Sans elles, un menu borné par `rows` se coupait net sur une
 * ligne entière sans rien dire, et le catalogue de modèles n'en montrait que
 * six sur vingt-six : rien à l'écran ne disait qu'il y en avait vingt de plus.
 *
 * Elles se posent PAR-DESSUS la liste, jamais dans son flux. La marge négative
 * annule leur hauteur, donc aucune ligne n'est perdue et le calcul de `rows`
 * reste exact. `sticky` n'est pas là pour coller quoi que ce soit : c'est le
 * Viewport qui défile, pas ce panneau (mesuré : `scrollHeight` 1080 sur le
 * Viewport, 222 et sans débordement sur le Content). Il sert à ouvrir un
 * contexte de positionnement, sans lequel `z-10` reste lettre morte sur un
 * élément statique et le Viewport, plus loin dans le DOM, peindrait par-dessus.
 * Le dégradé vers le fond de la carte fait le fondu sur la ligne qui passe
 * dessous.
 */
const SCROLL_CHEVRON =
  "z-10 flex h-6 cursor-default items-center justify-center text-muted-foreground/70 [&_svg:not([class*='size-'])]:size-4"

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn(
        SCROLL_CHEVRON,
        "sticky top-0 -mx-1.5 -mb-6 bg-gradient-to-b from-card from-55% to-transparent px-1.5",
        className
      )}
      {...props}
    >
      <ChevronUpIcon />
    </SelectPrimitive.ScrollUpButton>
  )
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn(
        SCROLL_CHEVRON,
        "sticky bottom-0 -mx-1.5 -mt-6 bg-gradient-to-t from-card from-55% to-transparent px-1.5",
        className
      )}
      {...props}
    >
      <ChevronDownIcon />
    </SelectPrimitive.ScrollDownButton>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
