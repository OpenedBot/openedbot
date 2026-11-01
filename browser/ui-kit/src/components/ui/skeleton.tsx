import type * as React from "react"
import { cn } from "../../lib/utils"

/**
 * Le bloc de base. `motion-reduce:animate-none` vit ICI : chaque appel le
 * répétait à la main, et un seul oubli laissait pulser un écran pour qui a
 * demandé moins de mouvement.
 *
 * La teinte se lit dans `--skeleton` (à défaut `--muted`), héritée du
 * conteneur : `--muted` vaut le gris des surfaces BoardUI
 * (`background-secondary-default`, #f7f7f7), et une forme posée sur ce gris
 * y disparaissait. Une surface grise pose donc `[--skeleton:...]` d'un cran
 * plus sombre ; une carte blanche (`SkeletonCard`) revient à `--muted`.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-[color:var(--skeleton,var(--muted))] motion-reduce:animate-none", className)}
      {...props}
    />
  )
}

/**
 * L'enveloppe d'une silhouette : UNE annonce pour les lecteurs d'écran
 * (« Chargement… »), et des formes muettes dessous. Sans elle, chaque bloc
 * gris serait un nœud vide de plus dans l'arbre d'accessibilité.
 */
function SkeletonRegion({
  label,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & { label: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      aria-busy="true"
      data-slot="skeleton-region"
      className={className}
      {...props}
    >
      <div aria-hidden className="contents">{children}</div>
    </div>
  )
}

/** Des lignes de texte ; la dernière plus courte, comme un vrai paragraphe. */
function SkeletonText({
  lines = 1,
  className,
  lineClassName,
}: {
  lines?: number
  className?: string
  lineClassName?: string
}) {
  return (
    <div data-slot="skeleton-text" className={cn("grid gap-1.5", className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          className={cn("h-3.5", lines > 1 && index === lines - 1 ? "w-2/3" : "w-full", lineClassName)}
        />
      ))}
    </div>
  )
}

/** Un visage ou une icône ronde. */
function SkeletonAvatar({ className }: { className?: string }) {
  return <Skeleton data-slot="skeleton-avatar" className={cn("size-10 shrink-0 rounded-full", className)} />
}

/** Une rangée de liste : visage, titre, aperçu (la géométrie des lignes de bots). */
function SkeletonListRow({ className, avatarClassName }: { className?: string; avatarClassName?: string }) {
  return (
    <div data-slot="skeleton-list-row" className={cn("flex h-[54px] items-center gap-2.5 p-1.5", className)}>
      <SkeletonAvatar className={avatarClassName} />
      <div className="grid min-w-0 flex-1 gap-1.5">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-11/12" />
      </div>
    </div>
  )
}

/**
 * Une carte : un titre, une valeur, une ligne de contexte. En sombre, la carte
 * (#262626) a la teinte de `--muted` : ses formes passent à neutral-700.
 */
function SkeletonCard({ className, children }: { className?: string; children?: React.ReactNode }) {
  return (
    <div
      data-slot="skeleton-card"
      className={cn("flex flex-col gap-3 rounded-2xl bg-card p-4 [--skeleton:var(--muted)] dark:[--skeleton:#404040]", className)}
    >
      {children ?? (
        <>
          <Skeleton className="h-3.5 w-1/3" />
          <Skeleton className="h-7 w-1/2" />
          <Skeleton className="h-3 w-3/4" />
        </>
      )}
    </div>
  )
}

export { Skeleton, SkeletonAvatar, SkeletonCard, SkeletonListRow, SkeletonRegion, SkeletonText }
