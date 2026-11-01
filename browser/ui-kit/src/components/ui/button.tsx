"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "../../lib/utils"

/**
 * BoardUI Button : matches https://www.boardui.com/components/button
 *
 * Variants: primary | secondary | ghost | soft | danger
 * Sizes:    md (36px) | sm (32px) | xs (24px)
 * Icons:    leadingIcon / trailingIcon (component refs), iconOnly for square hits
 *
 * Un écart assumé avec BoardUI : `ghost` suit la sémantique de shadcn
 * (transparent au repos), et l'aplat teinté de BoardUI s'appelle `soft`. Voir
 * le commentaire sur la variante.
 */

type IconComponent = React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-0.5 overflow-hidden whitespace-nowrap",
    "font-sans text-sm font-medium select-none cursor-pointer",
    "transition-[background-color,background-image,border-color,box-shadow,color] duration-150 ease-out",
    "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
    "disabled:cursor-not-allowed aria-disabled:cursor-not-allowed",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        primary:
          "bg-[image:var(--gradient-primary)] text-primary-foreground shadow-[var(--shadow-xs)] hover:bg-[image:var(--gradient-primary-hover)] active:bg-[image:var(--gradient-primary-active)] disabled:bg-[image:var(--gradient-primary-disabled)] disabled:text-muted-foreground disabled:shadow-none aria-disabled:bg-[image:var(--gradient-primary-disabled)] aria-disabled:text-muted-foreground aria-disabled:shadow-none",
        secondary:
          "border border-input bg-card text-foreground shadow-[var(--shadow-xs)] hover:bg-surface-hover hover:border-border active:bg-muted disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none aria-disabled:bg-muted aria-disabled:text-muted-foreground aria-disabled:shadow-none",
        /**
         * `ghost` au sens de shadcn : transparent au repos, fond NEUTRE au
         * survol.
         *
         * BoardUI appelle « ghost » autre chose : un aplat teinté de la couleur
         * de marque, au repos (`--button-ghost` = `--accent-100`, texte en
         * `--accent-700`). Fidèle à leur catalogue, mais faux pour ce à quoi
         * cette variante sert ici : les cinq appels sont des affordances de
         * faible emphase : replier la barre, fermer un panneau, trier une
         * colonne, relancer un tirage, ajouter un bot. Peintes en bleu plein,
         * elles criaient plus fort que le contenu qu'elles servent.
         *
         * L'aplat teinté n'est pas perdu : il vit sous `soft`, avec ses tokens.
         */
        ghost:
          "bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground active:bg-accent disabled:bg-transparent disabled:text-muted-foreground aria-disabled:bg-transparent aria-disabled:text-muted-foreground",
        soft:
          "bg-[var(--button-ghost)] text-[var(--button-ghost-fg)] hover:bg-[var(--button-ghost-hover)] active:bg-[var(--button-ghost-active)] disabled:bg-[var(--button-ghost-disabled)] disabled:text-[var(--button-ghost-disabled-fg)] disabled:shadow-none aria-disabled:bg-[var(--button-ghost-disabled)] aria-disabled:text-[var(--button-ghost-disabled-fg)]",
        danger:
          "bg-[image:var(--gradient-danger)] text-white shadow-[var(--shadow-xs)] hover:bg-[image:var(--gradient-danger-hover)] active:bg-[image:var(--gradient-danger-active)] disabled:bg-[image:var(--gradient-danger-disabled)] disabled:text-neg-700 disabled:shadow-none aria-disabled:bg-[image:var(--gradient-danger-disabled)] aria-disabled:text-neg-700 aria-disabled:shadow-none",
        /* shadcn aliases */
        default:
          "bg-[image:var(--gradient-primary)] text-primary-foreground shadow-[var(--shadow-xs)] hover:bg-[image:var(--gradient-primary-hover)] active:bg-[image:var(--gradient-primary-active)] disabled:bg-[image:var(--gradient-primary-disabled)] disabled:text-muted-foreground disabled:shadow-none",
        outline:
          "border border-input bg-card text-foreground shadow-[var(--shadow-xs)] hover:bg-surface-hover hover:border-border active:bg-muted disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none",
        destructive:
          "bg-[image:var(--gradient-danger)] text-white shadow-[var(--shadow-xs)] hover:bg-[image:var(--gradient-danger-hover)] active:bg-[image:var(--gradient-danger-active)] disabled:bg-[image:var(--gradient-danger-disabled)] disabled:text-neg-700 disabled:shadow-none",
        link: "text-primary underline-offset-4 hover:underline shadow-none",
      },
      size: {
        md: "h-9 rounded-[10px] p-2",
        sm: "h-8 rounded-lg px-2 py-1.5",
        xs: "h-6 rounded-sm px-2 text-xs font-semibold",
        /* shadcn aliases */
        default: "h-9 rounded-[10px] p-2",
        lg: "h-9 rounded-[10px] p-2",
        icon: "size-9 rounded-[10px] p-0",
        "icon-sm": "size-8 rounded-lg p-0",
        "icon-xs": "size-6 rounded-sm p-0",
        "icon-lg": "size-9 rounded-[10px] p-0",
      },
      iconOnly: {
        true: "",
        false: "",
      },
    },
    compoundVariants: [
      { iconOnly: true, size: "md", class: "size-9 p-0" },
      { iconOnly: true, size: "default", class: "size-9 p-0" },
      { iconOnly: true, size: "lg", class: "size-9 p-0" },
      { iconOnly: true, size: "sm", class: "size-8 p-0" },
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
  md: "size-5",
  default: "size-5",
  lg: "size-5",
  sm: "size-[18px]",
  xs: "size-3.5",
  icon: "size-5",
  "icon-sm": "size-[18px]",
  "icon-xs": "size-3.5",
  "icon-lg": "size-5",
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
        <span className="inline-flex shrink-0 items-center justify-center px-1">{children}</span>
      ) : null}
      {TrailingIcon ? <TrailingIcon aria-hidden className={ico} /> : null}
    </button>
  )
}

export { Button, buttonVariants }
