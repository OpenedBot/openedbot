import { Children, isValidElement, useState, type ComponentProps, type ReactNode } from "react";
import { Badge, cn, useIsMobile } from "@openedbot/browser-ui-kit";

/**
 * The shared bricks of the settings screens: our equivalent, here, of
 * `SectionHeading` / `Card` / `Badge tone` from the reference console.
 *
 * They exist so that one settings screen is not set apart from another
 * by its geometry: same title, same card, same pill. What changes from one
 * screen to the next is what it says, never the way of saying it.
 */

export type Tone = "success" | "info" | "neutral" | "warning" | "danger";

const TONE_CLASS: Record<Tone, string> = {
  success: "border-pos-700/40 bg-pos-soft text-pos-700",
  info: "border-info-700/40 bg-info-soft text-info-700",
  neutral: "border-border text-muted-foreground",
  warning: "border-warn-700/40 bg-warn-soft text-warn-700",
  danger: "border-destructive/40 bg-neg-soft text-destructive-text",
};

/** BoardUI chart-2 (lime-400): « runtime prêt » on a thread, and the positive facts. */
export const ALIVE_BADGE =
  "border-lime-400/40 bg-lime-400/15 text-lime-700 dark:text-lime-400";

/**
 * The action row of a card, of a form or of a dialog: at the bottom,
 * **on the right**, always.
 *
 * A single surface already did it: `gate-card.tsx`, the decision card,
 * and it is precisely the one where the user must find the button without
 * looking for it. Everywhere else the actions were stuck on the left, under
 * fields of variable width: the eye had to start again at the beginning of the line on
 * each card, and the button's position changed from one screen to the next. The
 * point is not the look, it is that the same gesture is found in the same
 * place.
 *
 * The order inside does not change: the secondary action first, the
 * primary one last, so the primary one is the furthest to the right, in the corner, there
 * where the cursor finishes its course.
 *
 * `flex-wrap`: at 768 px (the window's minimum width, `lib.rs`), two
 * buttons plus a long label overflowed without it.
 */
export const ACTIONS = "openedbot-settings-actions flex flex-wrap items-center justify-end gap-2";

/** A status pill. A fact, never a button. */
export function ToneBadge({
  tone,
  children,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Badge variant="outline" className={cn("font-normal", TONE_CLASS[tone], className)}>
      {children}
    </Badge>
  );
}

/**
 * A settings screen's title, its sentence, and the action or the pill on the right.
 *
 * In the settings modal, its header already carries the section's title
 * (`SettingsModalHeader`): it is not repeated on the screen, it stays for
 * screen readers, as on mobile where the navigation bar carries it.
 */
export function SectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  const isMobile = useIsMobile();
  if (isMobile) {
    return (
      <div data-settings-caption="" className="px-4 pb-1">
        <h1 className="sr-only">{title}</h1>
        {description ? (
          <p className="text-[13px] leading-4 text-[var(--openedbot-grouped-caption)]">{description}</p>
        ) : null}
        {action ? <div className={`mt-3 ${ACTIONS}`}>{action}</div> : null}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-base font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="max-w-[72ch] text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action ? <div className={`shrink-0 ${ACTIONS}`}>{action}</div> : null}
    </div>
  );
}

/**
 * A settings card: the edge, the background, and nothing else.
 *
 * On PHONE it becomes an iOS list GROUP. The difference is not
 * cosmetic: a web card contains its title, an iOS group is headed by it,
 * and its explanation lives under the card. It is this shift: title
 * inside rather than above: that makes a settings screen read as a
 * page and not as Settings.
 *
 * The title is LIFTED from the `CardHeading` the card already carries: no
 * screen has to be rewritten to take advantage of it, and a `CardHeading` placed
 * deeper (in a fragment, a condition) stays where it is.
 *
 * On desktop nothing moves.
 */
/**
 * Desktop: a card in two layers (`DESIGN.md` › Bureau › Carte). The SHELL, a
 * solid recessed tray (`surface-sunken`, the dialogs' tray too, so both read
 * as one colour), carries the title and its sentence; the INSET, the white card (`bg-card`, #262626 in dark) set in it
 * with a 6 px margin, carries the content, its rows and its footer. Three
 * steps of surface (page, tray, card) keep the card readable in dark, where a
 * single `bg-card` panel used to melt into the page. Shared by
 * `SettingsCard`, `ListSection` and the screens that draw their own card.
 */
export const SETTINGS_SHELL =
  "flex flex-col rounded-[20px] border border-border/60 bg-surface-sunken p-1.5";
export const SETTINGS_SHELL_HEADER = "px-3 pt-2.5 pb-3";
export const SETTINGS_INSET =
  "flex min-h-0 flex-1 flex-col overflow-hidden rounded-[14px] border border-border/60 bg-card shadow-sm";
/** A lone surface (a toolbar, a row-card): the inset's look, without a tray. */
export const SETTINGS_PANEL = "rounded-[14px] border border-border/60 bg-card shadow-sm";

export function SettingsCard({
  children,
  caption,
  footer,
  captionAction,
  className,
  padded = true,
  ...rest
}: {
  children: ReactNode;
  /** The group's title. Failing that, the `CardHeading` carried by the card. */
  caption?: string;
  /** The sentence that explains the group: under the card on phone. */
  footer?: ReactNode;
  /** A pill or a link, to the right of the group's title. */
  captionAction?: ReactNode;
  className?: string;
  padded?: boolean;
} & Omit<ComponentProps<"section">, "children" | "className">) {
  const isMobile = useIsMobile();
  let body = children;
  let groupCaption = caption;
  let groupFooter = footer;
  let groupAction = captionAction;

  if (isMobile) {
    const kept: ReactNode[] = [];
    for (const child of Children.toArray(children)) {
      if (isValidElement<CardHeadingProps>(child) && child.type === CardHeading) {
        groupCaption = groupCaption ?? child.props.title;
        groupFooter = groupFooter ?? child.props.description;
        groupAction = groupAction ?? child.props.action;
        continue;
      }
      kept.push(child);
    }
    body = kept;
  }

  if (!isMobile) {
    // Title on top, content under a hairline; `className` lays out the content.
    let heading: ReactNode = caption || footer ? <CardHeading title={caption ?? ""} description={footer} action={captionAction} /> : null;
    const content: ReactNode[] = [];
    for (const child of Children.toArray(children)) {
      if (!heading && isValidElement<CardHeadingProps>(child) && child.type === CardHeading) heading = child;
      else content.push(child);
    }
    // The title on the tray, the content in the card set in it; `className`
    // lays out the content.
    return (
      <section data-settings-card="" className={SETTINGS_SHELL} {...rest}>
        {heading ? <div className={SETTINGS_SHELL_HEADER}>{heading}</div> : null}
        <div className={SETTINGS_INSET}>
          <div className={cn("[&>:first-child]:mt-0", padded && "p-4", className)}>{heading ? content : children}</div>
        </div>
      </section>
    );
  }

  const card = (
    <section
      data-settings-card=""
      className={cn("rounded-[20px] bg-[var(--openedbot-grouped-card)]", padded && "p-4", className)}
      {...rest}
    >
      {body}
    </section>
  );

  if (!isMobile || (!groupCaption && !groupFooter && !groupAction)) return card;
  return (
    /* `data-inset-grouped`: the group takes the inset of the shell's lists
       (`mobile.css`), and the card it carries stops setting its own. Without that
       the title and the card started from two different x. */
    <div data-settings-group="" data-inset-grouped="">
      {groupCaption || groupAction ? (
        <div className="flex min-h-5 items-center justify-between gap-3 px-4 pb-2">
          {groupCaption ? (
            <h2 className="min-w-0 flex-1 truncate text-[13px] leading-4 font-normal text-[var(--openedbot-grouped-caption)]">
              {groupCaption}
            </h2>
          ) : null}
          {groupAction ? (
            <div data-settings-group-action="" className="shrink-0">
              {groupAction}
            </div>
          ) : null}
        </div>
      ) : null}
      {card}
      {groupFooter ? (
        <p className="px-4 pt-2 text-[13px] leading-4 text-[var(--openedbot-grouped-caption)]">
          {groupFooter}
        </p>
      ) : null}
    </div>
  );
}

/** A desktop card's title, on its tray: the strongest line of the card. */
export const CARD_TITLE = "text-[15px] leading-5 font-semibold tracking-[-0.01em] text-foreground";
/** The sentence under it. */
export const CARD_DESCRIPTION = "mt-0.5 max-w-[68ch] text-[13px] leading-5 text-muted-foreground";

type CardHeadingProps = {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  id?: string;
};

/** A card's title, with its explanation and an action on the right. */
export function CardHeading({ title, description, action, id }: CardHeadingProps) {
  const isMobile = useIsMobile();
  return (
    <div className={cn("flex flex-col gap-3", !isMobile && "sm:flex-row sm:items-start sm:justify-between")}>
      <div>
        <h2
          id={id}
          className={
            isMobile
              ? "text-[13px] leading-4 font-normal text-[var(--openedbot-grouped-caption)]"
              : CARD_TITLE
          }
        >
          {title}
        </h2>
        {description ? (
          <p
            className={
              isMobile
                ? "mt-1 text-[13px] leading-4 text-[var(--openedbot-grouped-caption)]"
                : CARD_DESCRIPTION
            }
          >
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className={`shrink-0 ${ACTIONS}`}>{action}</div> : null}
    </div>
  );
}

export { StatusGrid, StatusList, StatusRow, StatusTile } from "./status-list";

/**
 * A section as a LIST: a quiet title above, then a single block of which
 * each row is a setting (label and sentence on the left, value or control
 * on the right), separated by hairlines.
 *
 * It is the geometry of a system's settings (and of the reference app, the benchmark of
 * the console): the eye goes down a single column of labels and a single
 * column of values, instead of jumping from one tile to the next in a grid
 * of cards. On phone it is the same iOS group as `SettingsCard`: title
 * above, sentence under the block.
 *
 * `footer` carries what is not a row (a note, an error): a `<ul>`
 * accepts only `<li>`.
 */
export function ListSection({
  title,
  description,
  action,
  footer,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  /** A pill or a link, to the right of the title. */
  action?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const isMobile = useIsMobile();
  if (isMobile) {
    return (
      <section data-settings-list="" data-settings-group="" data-inset-grouped="" className={className}>
        <div className="flex min-h-5 items-center justify-between gap-3 px-4 pb-2">
          <h2 className="min-w-0 flex-1 truncate text-[13px] leading-4 font-normal text-[var(--openedbot-grouped-caption)]">
            {title}
          </h2>
          {action ? <div data-settings-group-action="" className="shrink-0">{action}</div> : null}
        </div>
        <ul className="openedbot-status-list overflow-hidden rounded-[20px] bg-[var(--openedbot-grouped-card)]">{children}</ul>
        {description ? (
          <p className="px-4 pt-2 text-[13px] leading-4 text-[var(--openedbot-grouped-caption)]">{description}</p>
        ) : null}
        {footer ? <div className="space-y-2 pt-2">{footer}</div> : null}
      </section>
    );
  }
  return (
    // The title on the tray, the rows in the card set in it (`SETTINGS_INSET`).
    <section data-settings-list="" className={cn(SETTINGS_SHELL, className)}>
      <div className={cn("flex items-start justify-between gap-3", SETTINGS_SHELL_HEADER)}>
        <div className="min-w-0">
          <h2 className={CARD_TITLE}>{title}</h2>
          {description ? <p className={CARD_DESCRIPTION}>{description}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className={SETTINGS_INSET}>
        <ul className="divide-y divide-border/60">
          {children}
        </ul>
        {footer ? <div className="mt-auto space-y-2 border-t border-border/60 px-4 py-3">{footer}</div> : null}
      </div>
    </section>
  );
}

/**
 * A row of `ListSection`: the label and its sentence on the left, the value
 * (`value`, text) or the control (`children`) on the right.
 *
 * On desktop, `flex-wrap`: when the control no longer fits beside the label
 * (narrow window, long address), it goes below, set to the right, instead
 * of crushing the label. On phone the row does not wrap (the
 * value stays on the right and truncates, as in Settings), except `stacked`:
 * a field or a menu then takes the whole width under the label.
 */
export function ListRow({
  label,
  description,
  descriptionId,
  icon,
  value,
  mono = false,
  stacked = false,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  /** So that a field of the row points at its sentence (`aria-describedby`). */
  descriptionId?: string;
  /** An icon or an avatar pill, in front of the label. */
  icon?: ReactNode;
  value?: ReactNode;
  mono?: boolean;
  /** Phone only: the control goes under the label, full width. */
  stacked?: boolean;
  children?: ReactNode;
}) {
  const isMobile = useIsMobile();
  const hasValue = value !== undefined && value !== null;
  const stack = isMobile && stacked;
  return (
    <li
      data-settings-row=""
      className={cn(
        "flex items-center gap-x-4 gap-y-2 px-4",
        isMobile ? "min-h-12 py-2.5" : "min-h-14 py-3",
        (!isMobile || stack) && "flex-wrap",
      )}
    >
      {icon ? <span className="flex shrink-0 items-center text-muted-foreground [&>svg]:size-4">{icon}</span> : null}
      <div className={cn("min-w-0 flex-1 [overflow-wrap:anywhere]", !isMobile && "basis-48")}>
        <div
          className={
            isMobile
              ? "text-[17px] leading-[22px] text-[var(--openedbot-grouped-label)]"
              : "text-sm font-medium text-foreground"
          }
        >
          {label}
        </div>
        {description ? (
          <div
            id={descriptionId}
            className={
              isMobile
                ? "mt-0.5 text-[13px] leading-4 text-[var(--openedbot-grouped-caption)]"
                : "mt-0.5 text-xs leading-5 text-muted-foreground"
            }
          >
            {description}
          </div>
        ) : null}
      </div>
      {hasValue || children ? (
        <div
          className={cn(
            "flex min-w-0 items-center gap-2",
            !isMobile && "ml-auto max-w-full flex-wrap justify-end",
            isMobile && !stack && "max-w-[55%] shrink-0 justify-end",
            stack && "w-full basis-full flex-wrap [&>*]:flex-1",
          )}
        >
          {hasValue ? (
            <span
              className={cn(
                "min-w-0 truncate",
                isMobile
                  ? "text-[17px] leading-[22px] text-[var(--openedbot-grouped-caption)]"
                  : "text-sm font-medium text-foreground",
                mono && "font-mono text-[13px] font-normal",
              )}
            >
              {value}
            </span>
          ) : null}
          {children}
        </div>
      ) : null}
    </li>
  );
}

/** The rows of a `ListSection` while its data is arriving. */
export function ListRowsSkeleton({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, index) => (
        <li key={index} aria-hidden className="flex min-h-14 items-center gap-4 px-4 py-3">
          <div className="flex-1 space-y-1.5">
            <div className="h-3.5 w-32 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <div className="h-3 w-56 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          </div>
          <div className="h-4 w-24 animate-pulse rounded bg-muted motion-reduce:animate-none" />
        </li>
      ))}
      {/* After the rows: on phone the iOS hairline sits on the
          second child, and an invisible row at the head would shift it. */}
      <li className="sr-only" role="status">{label}</li>
    </>
  );
}

/** A card's skeleton while its data is arriving. */
export function CardSkeleton({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <SettingsCard>
      <div className="space-y-3" role="status" aria-label={label}>
        <div className="h-4 w-40 animate-pulse rounded bg-muted motion-reduce:animate-none" />
        {Array.from({ length: rows }, (_, index) => (
          <div
            key={index}
            className="h-10 animate-pulse rounded-lg bg-muted motion-reduce:animate-none"
          />
        ))}
      </div>
    </SettingsCard>
  );
}

/** An information notice in a card: a sentence, a tone. */
export function Note({
  tone = "neutral",
  children,
  role,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  role?: "status" | "alert";
  className?: string;
}) {
  const style = {
    success: "border-pos-700/40 bg-pos-soft text-pos-700",
    info: "border-info-700/40 bg-info-soft text-info-700",
    neutral: "border-border bg-surface-sunken text-muted-foreground",
    warning: "border-warn-700/40 bg-warn-soft text-warn-700",
    danger: "border-destructive/40 bg-neg-soft text-destructive-text",
  }[tone];
  const isMobile = useIsMobile();
  return (
    <p
      role={role}
      className={cn(
        "rounded-xl px-3 py-2 text-xs leading-5",
        isMobile ? "mx-4 border-0" : "border",
        style,
        className,
      )}
    >
      {children}
    </p>
  );
}

/**
 * The shared shape: only the COLOUR says the action. The colours are those
 * of the BoardUI button (boardui.com/components/button), served by the same
 * tokens as the ui-kit's `Button` (`app.css`): accent gradient for the
 * primary gesture, accent-tinted flat for a secondary constructive gesture
 * (connect, add), neutral surface and hairline for an ordinary gesture,
 * red gradient for a gesture that removes or unbinds. The accent follows the colour
 * chosen by the operator: nothing is hard-coded blue here.
 */
/** The reference app pill (`sand-kit-button` md, 32 px); colours: `--btn-*` tokens (ui-kit `app.css`). */
const BUTTON_SHAPE =
  "openedbot-settings-action inline-flex h-8 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full px-3 text-center text-sm font-medium cursor-pointer outline-none transition-[background-color,color] duration-[120ms] ease-out focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed";

/** The settings action button, one variant per kind of gesture, never falsely greyed. */
export const BUTTON = {
  /** The primary gesture of a screen or a modal: save, confirm. Solid neutral. */
  primary: `${BUTTON_SHAPE} openedbot-settings-action-primary bg-[var(--btn-neutral)] text-[var(--btn-neutral-fg)] hover:bg-[var(--btn-neutral-hover)] disabled:bg-[var(--btn-neutral-disabled)] disabled:text-foreground/30`,
  /** An ordinary gesture, nothing at stake: change, cancel, edit. Neutral veil. */
  secondary: `${BUTTON_SHAPE} bg-[var(--btn-veil)] text-foreground hover:bg-[var(--btn-veil-hover)] disabled:text-foreground/30`,
  /** A gesture that ADDS or links, less strong than `primary`: blue veil. */
  soft: `${BUTTON_SHAPE} bg-[var(--btn-accent)]/10 text-[var(--btn-accent)] hover:bg-[var(--btn-accent)]/15 disabled:opacity-40`,
  /** The small pill (sm, 24 px): a secondary gesture in a row or a list. */
  small:
    "openedbot-settings-action inline-flex h-6 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full bg-[var(--btn-veil)] px-2 text-center text-xs font-medium text-foreground cursor-pointer outline-none transition-[background-color,color] duration-[120ms] ease-out hover:bg-[var(--btn-veil-hover)] focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:text-foreground/30",
  /** A gesture that removes, deletes or unbinds. Solid red. */
  danger: `${BUTTON_SHAPE} bg-[var(--btn-danger)] text-white hover:bg-[var(--btn-danger-hover)] disabled:opacity-40`,
  /** The blue confirmation of a modal: confirm a non-destructive gesture. */
  confirm: `${BUTTON_SHAPE} bg-[var(--btn-accent)] text-white hover:bg-[var(--btn-accent-hover)] disabled:opacity-40`,
  /** The blue twin of `danger`: an informative gesture (copy a reference). */
  info: `${BUTTON_SHAPE} bg-[var(--btn-accent)]/10 text-[var(--btn-accent)] hover:bg-[var(--btn-accent)]/15 disabled:opacity-40`,
  /** The green twin: a button's « c'est fait » state (copied, saved). */
  success: `${BUTTON_SHAPE} bg-pos-soft text-pos-700 disabled:opacity-40`,
} as const;

export const FIELD =
  "openedbot-settings-field rounded-md border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * A screen's empty state: centred in the panel, a single voice.
 *
 * Three patterns copied by hand coexisted (a dashed `<p>` in
 * Models, a dashed card in Overview, a `<details>` in
 * Connectors): three geometries for saying the same thing, « there is nothing
 * here, and here is the gesture that fills it ». This one replaces them as we
 * go. The CTA is supplied by the caller (a `<Link>`, a button): the
 * primitive does not know the router.
 */
export function EmptyState({
  icon,
  title,
  description,
  actions,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  const isMobile = useIsMobile();
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center py-12">
      <div
        className={cn(
          "flex w-full max-w-sm flex-col items-center gap-3 px-6 py-10 text-center",
          isMobile
            ? "rounded-[20px] bg-[var(--openedbot-grouped-card)]"
            : "rounded-xl border border-dashed border-border",
        )}
      >
        {icon ? <div className="text-muted-foreground [&>svg]:h-8 [&>svg]:w-8">{icon}</div> : null}
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
        {actions ? <div className="mt-2 flex flex-col items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

/**
 * Copy a value: third occurrence of the pattern, hence the extraction.
 *
 * Both details inherited from the copies (Devices, Models) are kept:
 * `navigator.clipboard?` (absent outside a secure context) and the `.catch` which
 * never says « Copié » when permission has been refused.
 */
export function CopyButton({
  value,
  copyLabel,
  copiedLabel,
  className = BUTTON.secondary,
  copiedClassName,
}: {
  value: string;
  copyLabel: string;
  copiedLabel: string;
  className?: string;
  /** The button's appearance once copied: green « success » when the screen wants it. */
  copiedClassName?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={copied ? (copiedClassName ?? className) : className}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(value)
          .then(() => setCopied(true))
          .catch(() => setCopied(false));
      }}
    >
      {copied ? copiedLabel : copyLabel}
    </button>
  );
}
