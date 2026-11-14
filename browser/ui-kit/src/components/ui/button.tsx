"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "../../lib/utils"

/**
 * Le bouton de l'app de référence (`sand-kit-button`) : une pilule, un ton par nature
 * de geste, sans dégradé ni ombre.
 *
 * Variantes : primary (neutre plein : noir en clair, blanc en sombre, le
 * geste principal) | secondary (voile neutre) | ghost (transparent, voile au
 * survol) | accent (bleu plein) | soft (voile bleu) | danger (rouge plein) |
 * danger-soft (voile rouge). Les alias shadcn (`default`, `outline`,
 * `destructive`) suivent.
 * Tailles : md (32 px) | sm (28 px) | xs (24 px) | lg (36 px).
 */

type IconComponent = React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>

const NEUTRAL =
  "bg-[var(--btn-neutral)] text-[var(--btn-neutral-fg)] hover:bg-[var(--btn-neutral-hover)] aria-expanded:bg-[var(--btn-neutral-hover)] disabled:bg-[var(--btn-neutral-disabled)] disabled:text-foreground/30 aria-disabled:bg-[var(--btn-neutral-disabled)] aria-disabled:text-foreground/30"
const VEIL =
  "bg-[var(--btn-veil)] text-foreground hover:bg-[var(--btn-veil-hover)] aria-expanded:bg-[var(--btn-veil-hover)] disabled:bg-[var(--btn-veil)] disabled:text-foreground/30 aria-disabled:text-foreground/30"
const CLEAR =
  "bg-transparent text-foreground hover:bg-[var(--btn-veil)] aria-expanded:bg-[var(--btn-veil)] disabled:bg-transparent disabled:text-foreground/30 aria-disabled:text-foreground/30"
const DANGER =
  "bg-[var(--btn-danger)] text-white hover:bg-[var(--btn-danger-hover)] disabled:opacity-40 aria-disabled:opacity-40"

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-full",
    "font-sans font-medium select-none cursor-pointer",
    "transition-[background-color,color] duration-[120ms] ease-out",
    "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
    "disabled:cursor-not-allowed aria-disabled:cursor-not-allowed",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        primary: NEUTRAL,
        secondary: VEIL,
        ghost: CLEAR,
        accent:
          "bg-[var(--btn-accent)] text-white hover:bg-[var(--btn-accent-hover)] disabled:opacity-40 aria-disabled:opacity-40",
        soft:
          "bg-[var(--btn-accent)]/10 text-[var(--btn-accent)] hover:bg-[var(--btn-accent)]/15 disabled:opacity-40 aria-disabled:opacity-40",
        danger: DANGER,
        "danger-soft":
          "bg-[var(--btn-danger-veil)] text-[var(--btn-danger-fg)] hover:bg-[var(--btn-danger-veil-hover)] disabled:opacity-40 aria-disabled:opacity-40",
        /* shadcn aliases */
        default: NEUTRAL,
        outline: VEIL,
        destructive: DANGER,
        link: "rounded-none bg-transparent text-primary underline-offset-4 hover:underline",
      },
      size: {
        md: "h-8 px-3 text-sm",
        sm: "h-7 px-2.5 text-[13px]",
        xs: "h-6 px-2 text-xs",
        lg: "h-9 px-4 text-sm",
        /* shadcn aliases */
        default: "h-8 px-3 text-sm",
        icon: "size-8 p-0",
        "icon-sm": "size-7 p-0",
        "icon-xs": "size-6 p-0",
        "icon-lg": "size-9 p-0",
      },
      iconOnly: {
        true: "",
        false: "",
      },
    },
    compoundVariants: [
      { iconOnly: true, size: "md", class: "size-8 p-0" },
      { iconOnly: true, size: "default", class: "size-8 p-0" },
      { iconOnly: true, size: "lg", class: "size-9 p-0" },
      { iconOnly: true, size: "sm", class: "size-7 p-0" },
      { iconOnly: true, size: "xs", class: "size-6 p-0" },
    ],
    defaultVariants: {
      variant: "primary",
      size: "md",
      iconOnly: false,
    },
  }
)

const iconSize: Record<string, string> = {
  md: "size-4",
  default: "size-4",
  lg: "size-[18px]",
  sm: "size-3.5",
  xs: "size-3",
  icon: "size-4",
  "icon-sm": "size-3.5",
  "icon-xs": "size-3",
  "icon-lg": "size-[18px]",
}

function Button({
  className,
  variant = "primary",
  size = "md",
  iconOnly = false,
  leadingIcon: LeadingIcon,
  trailingIcon: TrailingIcon,
  asChild = false,
  unstyled = false,
  children,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    leadingIcon?: IconComponent
    trailingIcon?: IconComponent
    iconOnly?: boolean
    /** Keep the primitive's DOM/accessibility contract while a surface supplies its own skin. */
    unstyled?: boolean
  }) {
  const ico = iconSize[size ?? "md"] ?? "size-5"

  // `Slot.Root` exige UN seul élément enfant : il y projette props et classes.
  // Les trois emplacements du rendu normal en produisent trois : icône, texte
  // enveloppé, icône, et `React.Children.only` compte AUSSI les `null`. Donc
  // `<Button asChild>` levait « Expected a single React element child » même
  // sans aucune icône, et l'écran entier tombait sur l'ErrorBoundary sans que
  // le typecheck ni les tests n'en voient rien.
  //
  // En mode `asChild`, l'enfant est donc rendu tel quel, et les classes
  // atterrissent sur LUI plutôt que sur un `<span>` intercalé, c'est tout
  // l'objet de `asChild`. Les icônes sont à composer par l'appelant : les
  // injecter demanderait de cloner son élément, et un
  // `<Button asChild leadingIcon={…}>` qui les perdrait en silence serait pire
  // que la règle explicite.
  if (asChild) {
    return (
      <Slot.Root
        data-slot="button"
        data-variant={variant}
        data-size={size}
        className={unstyled ? className : cn(buttonVariants({ variant, size, iconOnly, className }))}
        {...props}
      >
        {children}
      </Slot.Root>
    )
  }

  return (
    <button
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={unstyled ? className : cn(buttonVariants({ variant, size, iconOnly, className }))}
      {...props}
    >
      {LeadingIcon ? <LeadingIcon aria-hidden className={ico} /> : null}
      {iconOnly ? (
        children
      ) : children != null && children !== false ? (
        <span className="inline-flex min-w-0 items-center justify-center truncate">{children}</span>
      ) : null}
      {TrailingIcon ? <TrailingIcon aria-hidden className={ico} /> : null}
    </button>
  )
}

export { Button, buttonVariants }
