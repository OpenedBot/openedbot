import { Children, isValidElement, useState, type ComponentProps, type ReactNode } from "react";
import { Badge, cn, useIsMobile } from "@openedbot/browser-ui-kit";

/**
 * Les briques communes des écrans de réglages : l'équivalent, chez nous, de
 * `SectionHeading` / `Card` / `Badge tone` de la console de référence.
 *
 * Elles existent pour qu'un écran de réglages ne se distingue pas d'un autre
 * par sa géométrie : même titre, même carte, même pastille. Ce qui change d'un
 * écran à l'autre est ce qu'il dit, jamais la façon de le dire.
 */

export type Tone = "success" | "info" | "neutral" | "warning" | "danger";

const TONE_CLASS: Record<Tone, string> = {
  success: "border-pos-700/40 bg-pos-soft text-pos-700",
  info: "border-info-700/40 bg-info-soft text-info-700",
  neutral: "border-border text-muted-foreground",
  warning: "border-warn-700/40 bg-warn-soft text-warn-700",
  danger: "border-destructive/40 bg-neg-soft text-destructive-text",
};

/** BoardUI chart-2 (lime-400) : « runtime prêt » sur un fil, et les faits positifs. */
export const ALIVE_BADGE =
  "border-lime-400/40 bg-lime-400/15 text-lime-700 dark:text-lime-400";

/**
 * La rangée d'actions d'une carte, d'un formulaire ou d'un dialogue : en bas,
 * **à droite**, toujours.
 *
 * Une seule surface le faisait déjà : `gate-card.tsx`, la carte de décision,
 * et c'est justement celle où l'utilisateur doit trouver le bouton sans le
 * chercher. Partout ailleurs les actions étaient collées à gauche, sous des
 * champs de largeur variable : l'œil devait repartir au début de la ligne à
 * chaque carte, et la position du bouton changeait d'un écran à l'autre. Le
 * point n'est pas l'esthétique, c'est qu'un même geste se trouve au même
 * endroit.
 *
 * L'ordre à l'intérieur ne change pas : l'action secondaire d'abord, la
 * principale en dernier, donc la principale est la plus à droite, au coin, là
 * où le curseur finit sa course.
 *
 * `flex-wrap` : à 768 px (la largeur minimale de la fenêtre, `lib.rs`), deux
 * boutons plus un libellé long débordaient sans lui.
 */
export const ACTIONS = "openedbot-settings-actions flex flex-wrap items-center justify-end gap-2";

/** Une pastille d'état. Un fait, jamais un bouton. */
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
 * Le titre d'un écran de réglages, sa phrase, et l'action ou la pastille à droite.
 *
 * Dans la modale des réglages, son en-tête porte déjà le titre de la rubrique
 * (`SettingsModalHeader`) : il ne se répète pas à l'écran, il reste pour les
 * lecteurs d'écran, comme sur mobile où la barre de navigation le porte.
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
 * Une carte de réglages : le bord, le fond, et rien d'autre.
 *
 * Sur TÉLÉPHONE elle devient un GROUPE de liste iOS. La différence n'est pas
 * cosmétique : une carte web contient son titre, un groupe iOS en est coiffé,
 * et sa phrase d'explication vit sous la carte. C'est ce décalage : titre
 * dedans plutôt que dessus : qui fait qu'un écran de réglages se lit comme une
 * page et non comme Réglages.
 *
 * Le titre est HISSÉ depuis le `CardHeading` que la carte porte déjà : aucun
 * écran n'a à se réécrire pour en profiter, et un `CardHeading` posé plus
 * profond (dans un fragment, une condition) reste où il est.
 *
 * Sur desktop rien ne bouge.
 */
/**
 * Desktop: ONE card, as `Card`: `bg-card` (white / #262626), the title on top,
 * the content under a hairline (`DESIGN.md` › Bureau › Carte). Shared by
 * `SettingsCard`, `ListSection` and the data tables.
 */
export const SETTINGS_SHELL = "overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm";
export const SETTINGS_PANEL = "rounded-xl border border-border/60 bg-card shadow-sm";
export const SETTINGS_SHELL_HEADER = "px-4 pt-3.5 pb-3";

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
  /** Titre du groupe. À défaut, celui du `CardHeading` porté par la carte. */
  caption?: string;
  /** La phrase qui explique le groupe : sous la carte sur téléphone. */
  footer?: ReactNode;
  /** Une pastille ou un lien, à droite du titre du groupe. */
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
    if (!heading) {
      return <section data-settings-card="" className={cn(SETTINGS_PANEL, padded && "p-4", className)} {...rest}>{children}</section>;
    }
    return (
      <section data-settings-card="" className={SETTINGS_SHELL} {...rest}>
        <div className={SETTINGS_SHELL_HEADER}>{heading}</div>
        <div className={cn("border-t border-border/60 [&>:first-child]:mt-0", padded && "p-4", className)}>{content}</div>
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
    /* `data-inset-grouped` : le groupe reprend l'inset des listes de la coque
       (`mobile.css`), et la carte qu'il porte cesse de poser le sien. Sans ça
       le titre et la carte partaient de deux x différents. */
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

type CardHeadingProps = {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  id?: string;
};

/** Le titre d'une carte, avec sa phrase d'explication et une action à droite. */
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
              : "text-sm font-medium text-foreground"
          }
        >
          {title}
        </h2>
        {description ? (
          <p
            className={
              isMobile
                ? "mt-1 text-[13px] leading-4 text-[var(--openedbot-grouped-caption)]"
                : "mt-1 max-w-[68ch] text-xs leading-5 text-muted-foreground"
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

/**
 * Au-delà de cette longueur, une valeur ne tient pas dans la colonne droite
 * d'une ligne de 430 pt : elle passe sous le libellé plutôt que de s'y
 * abréger. Mesuré sur les valeurs réelles des écrans (IP, dates, e-mails
 * tiennent ; une phrase ou une URL non).
 */
const STATUS_VALUE_MAX = 26;

/**
 * La valeur descend-elle sous le libellé ?
 *
 * Seul un texte se mesure. Un badge est court par construction, sauf quand il
 * porte une phrase entière (un message d'erreur mis en pastille) : on mesure
 * alors son texte, sinon le `truncate` de la colonne droite l'ampute à trois
 * mots sur téléphone.
 */
function statusValueWraps(value: ReactNode): boolean {
  if (typeof value === "number") return false;
  if (isValidElement<{ children?: ReactNode }>(value)) {
    return statusValueWraps(value.props.children);
  }
  if (typeof value !== "string") return false;
  return value.length > STATUS_VALUE_MAX;
}

/**
 * Une ligne d'un `<dl>` d'état : le libellé à gauche, la valeur à droite.
 *
 * Sur téléphone c'est la ligne de Réglages : libellé 17 pt à gauche, valeur en
 * gris à droite, 48 pt de haut. Elle EMPILAIT les deux (le `sm:` de la grille
 * ne se déclenche qu'à 640 px), ce qui donnait une colonne de paires
 * libellé/valeur en 12 px : la géométrie d'un tableau desktop rétréci, pas
 * celle d'une liste.
 */
export function StatusRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  const isMobile = useIsMobile();
  if (isMobile) {
    const wraps = statusValueWraps(value);
    return (
      <div className={cn("flex min-h-12 gap-3 px-4", wraps ? "flex-col justify-center py-3" : "items-center")}>
        <dt className="shrink-0 text-[17px] leading-[22px] text-[var(--openedbot-grouped-label)]">
          {label}
        </dt>
        <dd
          className={cn(
            "min-w-0 text-[var(--openedbot-grouped-caption)]",
            wraps
              ? "text-[15px] leading-5 break-words"
              : "flex-1 truncate text-right text-[17px] leading-[22px]",
            mono && "font-mono text-[13px]",
          )}
        >
          {value}
        </dd>
      </div>
    );
  }
  return (
    <div className="grid gap-1 px-4 py-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-center sm:gap-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 break-words text-xs text-foreground", mono && "font-mono")}>
        {value}
      </dd>
    </div>
  );
}

/**
 * Le `<dl>` qui porte des `StatusRow` : filets entre les lignes, pas de marge.
 *
 * `-mx-4` sur téléphone : la carte pose déjà 16 px de padding, et les lignes
 * en posent 16 autres. Sans ça le libellé démarrait à 32 px du bord de la
 * carte et le filet ne touchait jamais son bord droit : deux détails qui, mis
 * bout à bout, ne ressemblent plus à une liste système.
 */
export function StatusList({ children, className }: { children: ReactNode; className?: string }) {
  const isMobile = useIsMobile();
  return (
    <dl
      className={cn(
        isMobile ? "openedbot-status-list -mx-4" : "divide-y divide-border",
        className,
      )}
    >
      {children}
    </dl>
  );
}

/**
 * La variante « tuiles » de `StatusList` : le même `<dl>`, mis en grille.
 *
 * Une carte d'état ne dit souvent que des faits courts : un appareil, une IP,
 * deux dates. En lignes, chacun mange toute la largeur de la carte et laisse
 * les trois quarts vides ; l'œil descend quatre fois pour lire ce qui tient en
 * deux rangées. `StatusGrid` les met côte à côte. Le contenu ne change pas,
 * c'est le même `<dl>`, les mêmes `<dt>`/`<dd>`, donc la même lecture pour un
 * lecteur d'écran.
 *
 * Sur mobile la géométrie retombe sur la liste : les listes groupées iOS sont
 * un motif du système, pas une décoration qu'on remplace par une grille.
 */
export function StatusGrid({
  children,
  columns = 2,
  className,
}: {
  children: ReactNode;
  columns?: 2 | 3;
  className?: string;
}) {
  const isMobile = useIsMobile();
  if (isMobile) return <dl className={cn("openedbot-status-list -mx-4", className)}>{children}</dl>;
  return (
    <dl
      className={cn(
        "grid gap-2",
        columns === 3 ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2",
        className,
      )}
    >
      {children}
    </dl>
  );
}

/**
 * Une tuile d'état : le libellé au-dessus, la valeur en dessous.
 *
 * À poser dans un `StatusGrid`. Hors desktop elle redevient un `StatusRow`,
 * pour que l'appelant n'ait pas à écrire deux fois la même carte.
 */
export function StatusTile({
  label,
  value,
  icon,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  mono?: boolean;
}) {
  const isMobile = useIsMobile();
  if (isMobile) return <StatusRow label={label} value={value} mono={mono} />;
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-surface-sunken px-3 py-2.5">
      <dt className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {icon ? <span className="[&>svg]:size-3.5">{icon}</span> : null}
        {label}
      </dt>
      <dd className={cn("min-w-0 break-words text-sm text-foreground", mono && "font-mono text-xs")}>
        {value}
      </dd>
    </div>
  );
}

/**
 * Une section en LISTE : un titre discret au-dessus, puis un seul bloc dont
 * chaque ligne est un réglage (libellé et phrase à gauche, valeur ou commande
 * à droite), séparées par des filets.
 *
 * C'est la géométrie des réglages d'un système (et d'OpenBot, le benchmark de
 * la console) : l'œil descend une seule colonne de libellés et une seule
 * colonne de valeurs, au lieu de sauter d'une tuile à l'autre dans une grille
 * de cartes. Sur téléphone c'est le même groupe iOS que `SettingsCard` : titre
 * au-dessus, phrase sous le bloc.
 *
 * `footer` porte ce qui n'est pas une ligne (une note, une erreur) : un `<ul>`
 * n'accepte que des `<li>`.
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
  /** Une pastille ou un lien, à droite du titre. */
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
    // La coque grise autour d'un panneau bordé doublait le cadre en sombre.
    <section data-settings-list="" className={cn("flex flex-col", SETTINGS_SHELL, className)}>
      <div className={cn("flex items-start justify-between gap-3", SETTINGS_SHELL_HEADER)}>
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-foreground">{title}</h2>
          {description ? (
            <p className="mt-0.5 max-w-[68ch] text-xs leading-5 text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <ul className="divide-y divide-border/60 border-t border-border/60">
        {children}
      </ul>
      {footer ? <div className="mt-auto space-y-2 border-t border-border/60 px-4 py-3">{footer}</div> : null}
    </section>
  );
}

/**
 * Une ligne de `ListSection` : le libellé et sa phrase à gauche, la valeur
 * (`value`, du texte) ou la commande (`children`) à droite.
 *
 * Au bureau, `flex-wrap` : quand la commande ne tient plus à côté du libellé
 * (fenêtre étroite, adresse longue), elle passe dessous, calée à droite, au
 * lieu d'écraser le libellé. Sur téléphone la ligne ne se replie pas (la
 * valeur reste à droite et se tronque, comme dans Réglages), sauf `stacked` :
 * un champ ou un menu y prend alors toute la largeur sous le libellé.
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
  /** Pour qu'un champ de la ligne pointe sa phrase (`aria-describedby`). */
  descriptionId?: string;
  /** Une icône ou une pastille d'avatar, devant le libellé. */
  icon?: ReactNode;
  value?: ReactNode;
  mono?: boolean;
  /** Téléphone seulement : la commande passe sous le libellé, pleine largeur. */
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

/** Les lignes d'une `ListSection` pendant que sa donnée arrive. */
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
      {/* Après les lignes : sur téléphone le filet iOS se pose sur le
          deuxième enfant, et une ligne invisible en tête le décalerait. */}
      <li className="sr-only" role="status">{label}</li>
    </>
  );
}

/** L'ossature d'une carte pendant que sa donnée arrive. */
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

/** Un encart d'information dans une carte : une phrase, un ton. */
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
 * La forme commune : seule la COULEUR dit l'action. Les couleurs sont celles
 * du bouton BoardUI (boardui.com/components/button), servies par les mêmes
 * jetons que `Button` de l'ui-kit (`app.css`) : dégradé d'accent pour le geste
 * principal, aplat teinté d'accent pour un geste constructif secondaire
 * (connecter, ajouter), surface neutre et filet pour un geste ordinaire,
 * dégradé rouge pour un geste qui retire ou délie. L'accent suit la couleur
 * choisie par l'opérateur : rien n'est codé en bleu ici.
 */
/** La pilule de Grok Bot (`sand-kit-button` md, 32 px) ; couleurs : jetons `--btn-*` (ui-kit `app.css`). */
const BUTTON_SHAPE =
  "openedbot-settings-action inline-flex h-8 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full px-3 text-center text-sm font-medium cursor-pointer outline-none transition-[background-color,color] duration-[120ms] ease-out focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed";

/** Le bouton d'action des réglages, une variante par nature de geste, jamais grisé pour de faux. */
export const BUTTON = {
  /** Le geste principal d'un écran ou d'une modale : enregistrer, valider. Neutre plein. */
  primary: `${BUTTON_SHAPE} openedbot-settings-action-primary bg-[var(--btn-neutral)] text-[var(--btn-neutral-fg)] hover:bg-[var(--btn-neutral-hover)] disabled:bg-[var(--btn-neutral-disabled)] disabled:text-foreground/30`,
  /** Un geste ordinaire, sans enjeu : changer, annuler, modifier. Voile neutre. */
  secondary: `${BUTTON_SHAPE} bg-[var(--btn-veil)] text-foreground hover:bg-[var(--btn-veil-hover)] disabled:text-foreground/30`,
  /** Un geste qui AJOUTE ou relie, moins fort que `primary` : voile bleu. */
  soft: `${BUTTON_SHAPE} bg-[var(--btn-accent)]/10 text-[var(--btn-accent)] hover:bg-[var(--btn-accent)]/15 disabled:opacity-40`,
  /** La petite pilule (sm, 24 px) : un geste secondaire dans une ligne ou une liste. */
  small:
    "openedbot-settings-action inline-flex h-6 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full bg-[var(--btn-veil)] px-2 text-center text-xs font-medium text-foreground cursor-pointer outline-none transition-[background-color,color] duration-[120ms] ease-out hover:bg-[var(--btn-veil-hover)] focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:text-foreground/30",
  /** Un geste qui retire, supprime ou délie. Rouge plein. */
  danger: `${BUTTON_SHAPE} bg-[var(--btn-danger)] text-white hover:bg-[var(--btn-danger-hover)] disabled:opacity-40`,
  /** La confirmation bleue d'une modale : valider un geste non destructif. */
  confirm: `${BUTTON_SHAPE} bg-[var(--btn-accent)] text-white hover:bg-[var(--btn-accent-hover)] disabled:opacity-40`,
  /** Le jumeau bleu de `danger` : un geste informatif (copier une référence). */
  info: `${BUTTON_SHAPE} bg-[var(--btn-accent)]/10 text-[var(--btn-accent)] hover:bg-[var(--btn-accent)]/15 disabled:opacity-40`,
  /** Le jumeau vert : l'état « c'est fait » d'un bouton (copié, enregistré). */
  success: `${BUTTON_SHAPE} bg-pos-soft text-pos-700 disabled:opacity-40`,
} as const;

export const FIELD =
  "openedbot-settings-field rounded-md border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * L'état vide d'un écran : centré dans le panneau, une seule voix.
 *
 * Trois motifs recopiés à la main coexistaient (un `<p>` pointillé dans
 * Modèles, une carte pointillée dans la Vue d'ensemble, un `<details>` dans
 * Connecteurs) : trois géométries pour dire la même chose, « il n'y a rien
 * ici, et voilà le geste qui remplit ». Celui-ci les remplace au fur et à
 * mesure. Le CTA est fourni par l'appelant (un `<Link>`, un bouton) : la
 * primitive ne connaît pas le routeur.
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
 * Copier une valeur : troisième occurrence du motif, donc extraction.
 *
 * Les deux détails hérités des copies (Appareils, Modèles) sont conservés :
 * `navigator.clipboard?` (absent hors contexte sécurisé) et le `.catch` qui ne
 * dit jamais « Copié » quand la permission a été refusée.
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
  /** L'habit du bouton une fois copié : vert « success » quand l'écran le veut. */
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
