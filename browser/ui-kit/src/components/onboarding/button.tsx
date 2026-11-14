"use client"

import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils"
import { Button } from "../ui/button"

/**
 * The onboarding button: Multica's flat control, ported class for class.
 *
 * It is NOT the app's `Button`: ours is a boardui-derived control with a
 * vertical gradient, its own heights and a `leadingIcon` prop. Reskinning the
 * onboarding screens with it would have meant either rewriting Multica's
 * geometry into boardui's scale (and losing the match the port exists for) or
 * bending the app's button until every other screen moved with it. Two
 * buttons, each faithful to the surface it serves, is the smaller lie,
 * hence the `Ob` prefix and the separate `@openedbot/browser-ui-kit/components/onboarding` subpath.
 *
 * The visual recipe stays specific to onboarding, but the control itself is
 * composed through the app's shadcn `Button`. `asChild` keeps a single native
 * `<button>` and avoids the content wrapper used by the boardui skin, which
 * would otherwise change the spacing between onboarding icons and labels.
 */
const obButtonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-body font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,transform] outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-caption in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-label in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function ObButton({
  className,
  variant = "default",
  size = "default",
  type = "button",
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof obButtonVariants>) {
  return (
    <Button
      asChild
      unstyled
      variant={variant}
      size={size}
      className={cn(obButtonVariants({ variant, size, className }))}
    >
      <button type={type} {...props} />
    </Button>
  )
}

export { ObButton, obButtonVariants }
