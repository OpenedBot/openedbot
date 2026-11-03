import * as React from "react"
import { IconArrowDown } from "@tabler/icons-react"
import {
  MessageScroller as MessageScrollerPrimitive,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from "@shadcn/react/message-scroller"

import { cn } from "../../lib/utils"
import { Button } from "./button"

/**
 * `message-scroller` de shadcn, dans la variante RADIX de sa registry : celle
 * qui correspond à ce design system (`radix-ui` + `cn()`), et non la variante
 * Base UI ni celle react-aria.
 *
 * Vendoré à la main, comme tous les composants de ce dossier : le dépôt n'a
 * aucun `components.json`, et `shadcn add` en créerait un puis réécrirait les
 * alias de chemin de toute l'app pour un seul fichier. Le COMPORTEMENT, lui,
 * n'est pas recopié : il vient de `@shadcn/react/message-scroller`, un paquet
 * sans aucune dépendance runtime. Ce fichier n'est que l'habillage.
 *
 * Ce qu'il apporte et que `thread-anchor.ts` ne sait pas faire : garder la
 * position de lecture pendant qu'un texte s'écrit, ancrer le tour plutôt que
 * le dernier pixel, et charger de l'historique par le haut sans sursaut.
 *
 * Trois écarts avec l'amont, tous parce que l'utilitaire n'existe pas ici :
 *
 * - `inset-s-1/2` (inset logique) devient `left-1/2`. Le guichet n'est pas
 *   servi en écriture droite-à-gauche aujourd'hui ; le `rtl:translate-x-1/2`
 *   de l'amont est conservé pour le jour où il le sera.
 * - `scrollbar-gutter-stable` devient la propriété arbitraire
 *   `[scrollbar-gutter:stable]` : même effet, sans dépendre d'un utilitaire
 *   absent. Sans elle, la colonne saute d'une largeur de barre au premier
 *   débordement.
 * - l'icône vient de `@tabler/icons-react`, comme le reste de l'app, au lieu
 *   du sélecteur d'icônes de la documentation.
 *
 * `scroll-fade-b` et `scrollbar-thin` viennent respectivement de
 * `shadcn/tailwind.css` et du plugin `tailwind-scrollbar`, tous deux déjà
 * importés par `styles/app.css`.
 */

function MessageScrollerProvider(
  props: React.ComponentProps<typeof MessageScrollerPrimitive.Provider>
) {
  return <MessageScrollerPrimitive.Provider {...props} />
}

function MessageScroller({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Root>) {
  return (
    <MessageScrollerPrimitive.Root
      data-slot="message-scroller"
      className={cn(
        "cn-message-scroller group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden",
        className
      )}
      {...props}
    />
  )
}

function MessageScrollerViewport({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Viewport>) {
  return (
    <MessageScrollerPrimitive.Viewport
      data-slot="message-scroller-viewport"
      className={cn(
        "cn-message-scroller-viewport size-full min-h-0 min-w-0 scroll-fade-b scrollbar-thin [scrollbar-gutter:stable] overflow-y-auto overscroll-contain contain-content data-autoscrolling:scrollbar-thumb-transparent data-autoscrolling:scrollbar-track-transparent data-pending-scroll:invisible",
        className
      )}
      {...props}
    />
  )
}

function MessageScrollerContent({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Content>) {
  return (
    <MessageScrollerPrimitive.Content
      data-slot="message-scroller-content"
      className={cn("cn-message-scroller-content flex h-max min-h-full flex-col", className)}
      {...props}
    />
  )
}

function MessageScrollerItem({
  className,
  scrollAnchor = false,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Item>) {
  return (
    <MessageScrollerPrimitive.Item
      data-slot="message-scroller-item"
      scrollAnchor={scrollAnchor}
      className={cn(
        "cn-message-scroller-item min-w-0 shrink-0 [contain-intrinsic-size:auto_10rem] [content-visibility:auto]",
        className
      )}
      {...props}
    />
  )
}

function MessageScrollerButton({
  direction = "end",
  className,
  children,
  render,
  label,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Button> & {
  /** Le nom du geste pour un lecteur d'écran ; l'app le fournit traduit. */
  label?: string
}) {
  return (
    <MessageScrollerPrimitive.Button
      data-slot="message-scroller-button"
      data-direction={direction}
      direction={direction}
      className={cn(
        "cn-message-scroller-button absolute left-1/2 -translate-x-1/2 border-border bg-background text-foreground shadow-sm transition-[translate,scale,opacity] duration-200 hover:bg-muted hover:text-foreground data-[active=false]:pointer-events-none data-[active=false]:scale-95 data-[active=false]:opacity-0 data-[active=false]:duration-400 data-[active=false]:ease-[cubic-bezier(0.7,0,0.84,0)] data-[active=true]:translate-y-0 data-[active=true]:scale-100 data-[active=true]:opacity-100 data-[active=true]:ease-[cubic-bezier(0.23,1,0.32,1)] data-[direction=end]:bottom-4 data-[direction=end]:data-[active=false]:translate-y-full data-[direction=start]:top-4 data-[direction=start]:data-[active=false]:-translate-y-full rtl:translate-x-1/2 data-[direction=start]:[&_svg]:rotate-180",
        className
      )}
      render={render ?? <Button variant="secondary" size="icon-sm" iconOnly />}
      {...props}
    >
      {children ?? (
        <>
          <IconArrowDown aria-hidden className="size-[18px]" />
          <span className="sr-only">{label ?? "Aller au dernier message"}</span>
        </>
      )}
    </MessageScrollerPrimitive.Button>
  )
}

export {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
}
