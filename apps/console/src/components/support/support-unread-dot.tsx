import { cn } from "@openedbot/browser-ui-kit";

/**
 * Le compteur de réponses non lues, posé sur la porte du guichet.
 *
 * Deux portes, un seul repère : la bulle flottante et le bouton d'en-tête
 * l'affichent à l'identique, parce que c'est le même fait. Le nombre est
 * plafonné à `9+` : au-delà, ce qui compte n'est plus combien, c'est qu'il y en
 * a. `aria-hidden` parce que le libellé du bouton le dit déjà en mots ; un
 * lecteur d'écran n'a pas à entendre « 3 » deux fois.
 */
export function SupportUnreadDot({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      aria-hidden
      data-support-unread={count}
      className={cn(
        "pointer-events-none absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center",
        "rounded-full bg-primary px-1 text-[11px] font-medium leading-none text-primary-foreground",
        "ring-2 ring-background",
        className,
      )}
    >
      {count > 9 ? "9+" : count}
    </span>
  );
}
