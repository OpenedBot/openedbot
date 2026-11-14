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

/** Header action, 44 pt, like the hamburger. Not a BoardUI `Button`. */
export function ChromeIconButton({
  label,
  onClick,
  icon: Icon,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  /** The action stays readable but refuses the finger, no button that disappears under the thumb. */
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
 * The mobile navigation bar, 44 pt under the status bar, like the header
 * of a drawer screen in expo-router: on the left the panel button (or
 * « Retour » on a pushed section), the title, then the actions.
 *
 * Title CENTRED by default, like every iOS navigation bar: the left
 * column (menu or « Retour ») and the right one (actions) share the
 * rest in equal parts, so the title falls at the screen's optical centre whatever
 * the buttons' width.
 *
 * `align="start"` stays for CONVERSATIONS, and for them alone: a
 * face, a name and the task selector do not centre between two
 * groups of buttons, it is WhatsApp's layout, robust to any
 * title width.
 *
 * The background is the scene's: the bar travels with the card when the
 * panel opens (`headerStyle: { backgroundColor: colors.background }`).
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
  /** Second line under the title: the task selector, a group's state. */
  subtitle?: ReactNode;
  /**
   * A conversation's face, to the left of the title and covering its two
   * lines, like the contact photo in WhatsApp or iMessage. With
   * `align="start"` only: a centred bar has no column for it.
   */
  avatar?: ReactNode;
  actions?: ReactNode;
  /** Destination of the « Retour » button; by default deduced from the path. */
  back?: string | null;
  className?: string;
  /** `false`: the `h1` lives in the scene (home `/`). */
  heading?: boolean;
  /**
   * `start`: the title is set to the left: a conversation, where it carries a
   * face and a name. Everywhere else it is `center`, the iOS bar.
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
            THE CHEVRON ALONE, never « ‹ Retour ».

            The word weighed 84 px of blue to the left of a right column most
            often empty: the title stayed at the geometric centre, but the
            composition made it read as offset, and it lost 84 px of width
            for nothing. Without it, the two side columns are worth 44 pt, the
            title has the whole screen minus 88, and the balance shows. The destination's
            name lives in `aria-label`, not on screen.
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
