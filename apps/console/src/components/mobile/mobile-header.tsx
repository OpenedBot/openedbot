import type { ComponentType, ReactNode } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { IconChevronLeft, IconMenu2 } from "@tabler/icons-react";
import { cn } from "@openedbot/browser-ui-kit";
import { useT } from "../../lib/i18n";
import { mobileBackTarget } from "../../lib/shell/mobile-navigation";
import { insetBackClassName } from "./inset-grouped";
import { useMobileDrawer } from "./mobile-drawer-shell";

const HEADER_ICON_CLASS =
  "openedbot-press flex size-11 shrink-0 items-center justify-center rounded-lg text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Action d'en-tête, 44 pt, comme le hamburger. Pas un `Button` BoardUI. */
export function ChromeIconButton({
  label,
  onClick,
  icon: Icon,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  /** L'action reste lisible mais refuse le doigt, pas de bouton qui disparaît sous le pouce. */
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(HEADER_ICON_CLASS, disabled && "pointer-events-none opacity-40")}
    >
      <Icon className="size-6" aria-hidden />
    </button>
  );
}

/**
 * La barre de navigation mobile, 44 pt sous la barre d'état, comme l'en-tête
 * d'un écran du drawer chez expo-router : à gauche le bouton du panneau (ou
 * « Retour » sur une rubrique poussée), le titre, puis les actions.
 *
 * Titre CENTRÉ par défaut, comme toute barre de navigation iOS : la colonne
 * de gauche (menu ou « Retour ») et celle de droite (actions) partagent le
 * reste à parts égales, donc le titre tombe au centre optique de l'écran quelle
 * que soit la largeur des boutons.
 *
 * `align="start"` reste pour les CONVERSATIONS, et pour elles seules : un
 * visage, un nom et le sélecteur de tâche ne se centrent pas entre deux
 * groupes de boutons, c'est la disposition de WhatsApp, robuste à n'importe
 * quelle largeur de titre.
 *
 * Le fond est celui de la scène : la barre voyage avec la carte quand le
 * panneau s'ouvre (`headerStyle: { backgroundColor: colors.background }`).
 */
export function MobileHeader({
  title,
  subtitle,
  avatar,
  actions,
  back,
  className,
  heading = true,
  align = "center",
}: {
  title: ReactNode;
  /** Deuxième ligne sous le titre : le sélecteur de tâche, l'état d'un salon. */
  subtitle?: ReactNode;
  /**
   * Le visage d'une conversation, à gauche du titre et couvrant ses deux
   * lignes, comme la photo de contact dans WhatsApp ou iMessage. Avec
   * `align="start"` seulement : une barre centrée n'a pas de colonne pour lui.
   */
  avatar?: ReactNode;
  actions?: ReactNode;
  /** Destination du bouton « Retour » ; par défaut déduite du chemin. */
  back?: string | null;
  className?: string;
  /** `false` : le `h1` vit dans la scène (foyer `/`). */
  heading?: boolean;
  /**
   * `start` : le titre est calé à gauche : une conversation, où il porte un
   * visage et un nom. Partout ailleurs c'est `center`, la barre iOS.
   */
  align?: "start" | "center";
}) {
  const { t } = useT();
  const { pathname } = useLocation();
  const drawer = useMobileDrawer();
  const backTarget = back === undefined ? mobileBackTarget(pathname) : back;
  const centered = align === "center" && !subtitle;

  return (
    <header
      data-mobile-header=""
      data-align={centered ? "center" : undefined}
      className={cn(
        "shrink-0 border-b border-border/70 bg-background pt-[var(--openedbot-safe-top)] pr-[var(--openedbot-safe-right)] pl-[var(--openedbot-safe-left)] select-none",
        className,
      )}
    >
      <div
        className={cn(
          "items-center gap-1 px-1.5",
          centered
            ? "grid h-11 grid-cols-[minmax(2.75rem,1fr)_minmax(0,auto)_minmax(2.75rem,1fr)]"
            : cn("flex", subtitle ? "min-h-13 py-1" : "h-11"),
        )}
      >
        {backTarget !== null ? (
          /*
            Le CHEVRON SEUL, jamais « ‹ Retour ».

            Le mot pesait 84 px de bleu à gauche d'une colonne de droite le plus
            souvent vide : le titre restait au centre géométrique, mais la
            composition le donnait à lire décalé, et il perdait 84 px de largeur
            pour rien. Sans lui, les deux colonnes latérales valent 44 pt, le
            titre a l'écran entier moins 88, et l'équilibre se voit. Le nom de
            la destination vit dans `aria-label`, pas à l'écran.
          */
          <Link
            to={backTarget}
            aria-label={t("mobileShell.back")}
            data-inset-back=""
            className={insetBackClassName}
          >
            <IconChevronLeft className="size-7" aria-hidden="true" />
          </Link>
        ) : (
          <button
            type="button"
            aria-label={t("mobileShell.openMenu")}
            aria-expanded={drawer?.open ?? false}
            onClick={() => drawer?.toggle()}
            className={cn(HEADER_ICON_CLASS, centered && "justify-self-start")}
          >
            <IconMenu2 className="size-6" aria-hidden="true" />
          </button>
        )}
        {avatar && !centered ? (
          <div data-mobile-header-avatar="" className="flex shrink-0 items-center pr-0.5 pl-0.5">
            {avatar}
          </div>
        ) : null}
        {centered ? (
          <>
            {heading ? (
              <h1 className="min-w-0 truncate px-1 text-center text-[17px] leading-[22px] font-semibold">
                {title}
              </h1>
            ) : (
              <p className="min-w-0 truncate px-1 text-center text-[17px] leading-[22px] font-semibold">
                {title}
              </p>
            )}
            <div className="flex min-w-0 items-center justify-self-end gap-0.5">{actions}</div>
          </>
        ) : subtitle ? (
          <div className="flex min-w-0 flex-1 flex-col justify-center px-1">
            {heading ? (
              <h1 className="flex min-w-0 items-center gap-2 truncate text-headline-semibold">{title}</h1>
            ) : (
              <p className="flex min-w-0 items-center gap-2 truncate text-headline-semibold">{title}</p>
            )}
            <div data-mobile-header-subtitle="" className="flex min-w-0 items-center">
              {subtitle}
            </div>
          </div>
        ) : heading ? (
          <h1 className="flex min-w-0 flex-1 items-center gap-2 truncate px-1 text-headline-semibold">
            {title}
          </h1>
        ) : (
          <p className="flex min-w-0 flex-1 items-center gap-2 truncate px-1 text-headline-semibold">
            {title}
          </p>
        )}
        {actions && !centered ? <div className="flex shrink-0 items-center gap-0.5">{actions}</div> : null}
      </div>
    </header>
  );
}
