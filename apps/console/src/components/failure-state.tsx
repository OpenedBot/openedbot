import { Fragment, type ComponentType, type ReactNode } from "react";
import {
  IconBug,
  IconCloudOff,
  IconFileUnknown,
  IconHandStop,
  IconLock,
  IconPlugConnectedX,
  IconServerBolt,
  type IconProps,
} from "@tabler/icons-react";
import type { MessageKey } from "@openedbot/browser-i18n";
import { cn, useIsMobile } from "@openedbot/browser-ui-kit";
import { ApiError } from "../lib/api";
import { useFallbackT } from "../lib/i18n";
import { BUTTON, CopyButton } from "./settings/primitives";

/** Le code posé quand la requête n'a jamais atteint l'API (`api.ts`). */
const API_UNAVAILABLE = "API_UNAVAILABLE";

/**
 * La nature d'un échec : ce qui décide de tout le reste de l'écran.
 *
 * Un seul encadré rouge pour les sept cas disait la même chose d'une API
 * endormie, d'un droit manquant et d'un plantage serveur : trois pannes qui
 * n'appellent NI le même geste, NI la même urgence. La nature vient du couple
 * (classe d'erreur, statut HTTP), les deux seules choses qu'on observe sans
 * rien deviner.
 */
export type FailureKind =
  /** La requête n'est jamais partie (`API_UNAVAILABLE`, statut 0). */
  | "offline"
  /** 401 / 403 : l'API a répondu, et elle refuse l'accès. */
  | "denied"
  /** 404 : l'API a répondu, et l'objet n'existe pas. */
  | "missing"
  /** Autre 4xx : l'API a répondu, et elle refuse la demande telle quelle. */
  | "refused"
  /** 502 / 503 / 504 : ça s'arrête au-delà de l'API, vers le runtime. */
  | "upstream"
  /** 500 et autres 5xx : l'API elle-même a échoué. */
  | "fault"
  /** Pas une `ApiError` : une exception de rendu, rien n'a été demandé. */
  | "crash";

export type FailureDetail = {
  kind: FailureKind;
  message: string;
  requestId: string | null;
  facts: ReadonlyArray<readonly [string, string]>;
};

/**
 * Ce qu'on sait dire d'une erreur, sans jamais inventer.
 *
 * Une exception de programmation (`crypto.randomUUID is not a function`)
 * décrit notre code et pas le geste de l'opérateur : elle ne devient pas la
 * phrase de l'écran. Seule une `ApiError` (un refus que l'API a rédigé) a le
 * droit de parler.
 */
export function classifyFailure(error: unknown): FailureDetail {
  if (!(error instanceof ApiError)) {
    return { kind: "crash", message: "", requestId: null, facts: [] };
  }
  // Une API injoignable n'a ni statut ni référence : la requête n'est jamais
  // partie. Afficher « HTTP 0 » désignerait un état qui n'existe pas, et
  // `API_UNAVAILABLE` est un code que NOUS posons, pas un que l'API a rendu.
  if (error.code === API_UNAVAILABLE || error.status === 0) {
    return { kind: "offline", message: error.message, requestId: null, facts: [] };
  }
  const facts: Array<readonly [string, string]> = [];
  if (error.code) facts.push(["code", error.code]);
  facts.push(["HTTP", String(error.status)]);
  if (error.requestId) facts.push(["ref", error.requestId]);
  return {
    kind: kindOfStatus(error.status),
    message: error.message,
    requestId: error.requestId ?? null,
    facts,
  };
}

function kindOfStatus(status: number): FailureKind {
  if (status === 401 || status === 403) return "denied";
  if (status === 404) return "missing";
  if (status >= 400 && status < 500) return "refused";
  if (status === 502 || status === 503 || status === 504) return "upstream";
  return "fault";
}

export type HopKey = "browser" | "api" | "runtime";

/** Un trajet : ses étapes, et si le lien vers la dernière a été franchi. */
export type FailurePathShape = { hops: readonly HopKey[]; crossedIntoStop: boolean };

/**
 * Le trajet d'une requête openedbot, et où il s'arrête selon la nature de l'échec.
 *
 * openedbot est un relais (navigateur, API, lien connecteur, runtime) et l'API
 * distingue déjà une panne du lien d'une réponse de la gateway
 * (`X-OpenedBot-Relay-Stage`). Ce trajet est donc un FAIT du produit, pas une
 * décoration : il répond à la seule question qu'un opérateur ne peut pas
 * deviner, « jusqu'où est-ce allé », et c'est elle qui décide du geste suivant.
 *
 * `crossedIntoStop` sépare les deux natures d'arrêt : un lien FRANCHI mène à
 * une réponse (un refus reste une réponse), un lien NON FRANCHI veut dire que
 * l'étape suivante n'a rien vu passer. Les liens précédents sont franchis par
 * construction, sans quoi l'arrêt serait plus tôt.
 */
const PATHS: Record<FailureKind, FailurePathShape | null> = {
  offline: { hops: ["browser", "api"], crossedIntoStop: false },
  denied: { hops: ["browser", "api"], crossedIntoStop: true },
  missing: { hops: ["browser", "api"], crossedIntoStop: true },
  refused: { hops: ["browser", "api"], crossedIntoStop: true },
  fault: { hops: ["browser", "api"], crossedIntoStop: true },
  upstream: { hops: ["browser", "api", "runtime"], crossedIntoStop: false },
  // Rien n'a été demandé : un trajet dessinerait un voyage qui n'a pas eu lieu.
  crash: null,
};

const HOP_LABELS: Record<HopKey, MessageKey> = {
  browser: "errorState.hopBrowser",
  api: "errorState.hopApi",
  runtime: "errorState.hopRuntime",
};

/**
 * Deux tons, pas sept (règle « Couleur sémantique » de `DESIGN.md`) :
 *
 * - `info`, le bleu informatif : l'API a fait ce qu'elle devait, ou le trajet
 *   s'arrête hors de notre code (cloud endormi, accès refusé, objet absent,
 *   runtime muet). Il n'y a rien de cassé chez nous, l'écran informe.
 * - `danger`, le rouge des boutons « Supprimer » (`--destructive-text`,
 *   `bg-neg-soft`) : notre code a échoué (500, exception de rendu). Le même
 *   rouge que l'action irréversible, parce qu'il dit la même chose : ici, on
 *   ne revient pas en arrière tout seul.
 *
 * Le titre et l'icône restent neutres, comme dans n'importe quel écran vide :
 * la teinte ne va que sur ce qui porte l'état : l'étape du trajet où ça
 * s'arrête, le statut HTTP en pied de carte, et le bouton de la référence,
 * bâti comme le bouton « Supprimer » mais dans le ton.
 */
export type FailureTone = "info" | "danger";
type Tone = FailureTone;

const TONES: Record<Tone, { accent: string; chip: string; button: string }> = {
  info: {
    accent: "text-info-700",
    chip: "border-info-700/30 bg-info-soft text-info-700",
    button: BUTTON.info,
  },
  danger: {
    accent: "text-destructive-text",
    chip: "border-destructive/30 bg-neg-soft text-destructive-text",
    button: BUTTON.danger,
  },
};

const LOOKS: Record<FailureKind, {
  titleKey: MessageKey;
  pathKey: MessageKey | null;
  icon: ComponentType<IconProps>;
  tone: Tone;
}> = {
  offline: { titleKey: "errorState.offlineTitle", pathKey: "errorState.offlinePath", icon: IconCloudOff, tone: "info" },
  denied: { titleKey: "errorState.deniedTitle", pathKey: "errorState.deniedPath", icon: IconLock, tone: "info" },
  missing: { titleKey: "errorState.missingTitle", pathKey: "errorState.missingPath", icon: IconFileUnknown, tone: "info" },
  refused: { titleKey: "errorState.refusedTitle", pathKey: "errorState.refusedPath", icon: IconHandStop, tone: "info" },
  upstream: { titleKey: "errorState.upstreamTitle", pathKey: "errorState.upstreamPath", icon: IconPlugConnectedX, tone: "info" },
  fault: { titleKey: "errorState.faultTitle", pathKey: "errorState.faultPath", icon: IconServerBolt, tone: "danger" },
  crash: { titleKey: "errorState.crashTitle", pathKey: null, icon: IconBug, tone: "danger" },
};

/** La référence n'est promue que là où la transmettre EST le geste suivant. */
function referenceIsThePoint(kind: FailureKind): boolean {
  return kind === "fault" || kind === "upstream";
}

/** Un fait du pied de carte ; `status` : celui qui porte l'état, en pastille. */
export type FailureFact = { label: string; value: string; status?: boolean };

/**
 * L'échec d'un écran, dit selon sa nature.
 *
 * Quatre choses, dans cet ordre : ce qui s'est passé (le titre, propre à la
 * nature), ce que l'API en dit (sa phrase, jamais réécrite), jusqu'où la
 * requête est allée (le trajet), et de quoi agir : le geste de l'écran, plus la
 * référence quand la transmettre est tout ce qui reste à faire.
 *
 * Un écran qui connaît sa cause mieux que le statut HTTP (l'écran Modèles sait
 * que c'est le RUNTIME, et lequel) garde le titre, l'icône et ajoute ses faits
 * en tête du pied de carte ; la nature, le ton et le trajet restent ceux de
 * l'erreur observée.
 */
export function FailureState({
  error,
  fallback,
  title,
  icon,
  facts: extraFacts = [],
  action,
  art,
  className,
  placement = "pane",
}: {
  error: unknown;
  /** La phrase de l'écran, quand l'erreur n'en porte pas de lisible. */
  fallback: string;
  /** Le titre de l'écran, quand il en sait plus que la nature de l'erreur. */
  title?: string;
  icon?: ComponentType<IconProps>;
  /** Les faits propres à l'écran, écrits avant ceux de l'erreur. */
  facts?: ReadonlyArray<FailureFact>;
  action?: ReactNode;
  className?: string;
  /**
   * `pane` : la carte des réglages, centrée dans le panneau.
   * `page` : l'écran a lui-même cédé (frontière de rendu, 500). Le texte
   * occupe la page, aligné comme un message, sans carte ni icône.
   */
  placement?: "page" | "pane";
  /** `page` only: a decorative illustration beside the text. */
  art?: ReactNode;
}) {
  const { t } = useFallbackT();
  const detail = classifyFailure(error);
  const look = LOOKS[detail.kind];
  const promoted = detail.requestId !== null && referenceIsThePoint(detail.kind);
  // La référence promue ne se répète pas dans la ligne technique : la même
  // valeur écrite deux fois se lit comme deux valeurs.
  const facts = (promoted ? detail.facts.filter(([label]) => label !== "ref") : detail.facts)
    // Le statut HTTP est le seul fait de l'erreur qui porte l'état.
    .map(([label, value]): FailureFact => ({ label, value, status: label === "HTTP" }));
  const shape = PATHS[detail.kind];
  return (
    <FailureSurface
      icon={icon ?? look.icon}
      title={title ?? t(look.titleKey)}
      description={detail.message || fallback}
      tone={look.tone}
      path={shape && look.pathKey ? { shape, label: t(look.pathKey) } : null}
      facts={[...extraFacts, ...facts]}
      reference={promoted ? detail.requestId : null}
      action={action}
      art={art}
      className={className}
      placement={placement}
    />
  );
}

/**
 * La carte elle-même, sans rien décider : un écran qui connaît déjà sa cause
 * (le runtime n'a pas passé sa dernière vérification) la lui donne toute
 * faite, et parle de la même voix qu'un écran dont l'API a refusé la requête.
 *
 * Deux placements. `pane` reprend la géométrie d'`EmptyState` : une carte
 * centrée, une icône, un titre, une phrase, un geste. Le bord est plein, pas
 * pointillé : le pointillé est réservé au vide SANS cause (`DESIGN.md`). Le
 * pied de carte porte la ligne technique, séparée du reste par un filet.
 *
 * `page` est l'écran qui a cédé. Une carte flottante au milieu du vide se lit
 * comme une boîte de dialogue que personne n'a ouverte. Le titre tient la
 * page, aligné à gauche, à la largeur d'un message ; pas d'icône, pas de
 * pastille. Le geste vient ensuite, puis la ligne technique s'il y en a une.
 */
export function FailureSurface({
  icon: Icon,
  title,
  description,
  tone: toneName,
  path,
  facts,
  reference = null,
  action,
  art,
  className,
  placement = "pane",
}: {
  icon: ComponentType<IconProps>;
  title: string;
  description: string;
  tone: FailureTone;
  /** Le trajet et sa phrase (lue à la place du schéma) ; `null` : rien n'a été demandé. */
  path: { shape: FailurePathShape; label: string } | null;
  facts: ReadonlyArray<FailureFact>;
  /** La référence à transmettre, quand la transmettre est le geste. */
  reference?: string | null;
  action?: ReactNode;
  className?: string;
  placement?: "page" | "pane";
  art?: ReactNode;
}) {
  const isMobile = useIsMobile();
  const tone = TONES[toneName];
  if (placement === "page") {
    return (
      <FailurePage
        title={title}
        description={description}
        tone={tone}
        path={path}
        facts={facts}
        reference={reference}
        action={action}
        art={art}
        className={className}
        isMobile={isMobile}
      />
    );
  }
  return (
    <section
      role="alert"
      className={cn(
        // `flex-1` + `items-center` : la carte se centre dans ce que le
        // défileur laisse libre sous l'en-tête (`SettingsPane` est `min-h-full`).
        "flex w-full min-h-0 flex-1 items-center justify-center self-stretch py-8",
        // Le défileur mobile de `SettingsPane` est à `px-0` : la marge est au
        // contenu, comme pour `Note` et les listes groupées.
        isMobile ? "mx-4" : undefined,
        className,
      )}
    >
      <div
        className={cn(
          "flex w-full max-w-md flex-col items-center overflow-hidden text-center",
          isMobile ? "rounded-[20px] bg-[var(--ohb-grouped-card)]" : "rounded-xl border border-border bg-background",
        )}
      >
        <div className="flex w-full flex-col items-center gap-3 px-6 pb-6 pt-8">
          <span
            aria-hidden
            className="flex size-12 items-center justify-center rounded-full bg-surface-sunken text-muted-foreground"
          >
            <Icon size={24} stroke={1.75} />
          </span>
          <div className="space-y-1">
            <h2 className="text-base font-semibold tracking-tight text-foreground">{title}</h2>
            <p className="max-w-[46ch] text-sm leading-6 text-muted-foreground">{description}</p>
          </div>
          {path ? <FailurePath shape={path.shape} label={path.label} accent={tone.accent} /> : null}
          {reference ? <Reference value={reference} button={tone.button} /> : null}
          {action ? <div className="flex flex-wrap items-center justify-center gap-2 pt-1">{action}</div> : null}
        </div>
        {facts.length > 0 ? (
          <dl className="flex w-full flex-wrap items-center justify-center gap-x-3 gap-y-1.5 border-t border-border bg-surface-sunken/60 px-6 py-2.5 font-mono text-[11px] text-muted-foreground">
            {facts.map(({ label, value, status }) => (
              <div
                key={label}
                className={cn(
                  "flex items-center gap-1.5",
                  status ? cn("rounded-md border px-1.5 py-0.5", tone.chip) : undefined,
                )}
              >
                <dt className={cn("uppercase tracking-wide", status ? undefined : "opacity-70")}>{label}</dt>
                <dd className={status ? "font-semibold" : undefined}>{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </section>
  );
}

type FailureToneClasses = (typeof TONES)[FailureTone];

/**
 * L'écran qui a cédé, plein cadre.
 *
 * Le titre est le seul élément fort : une phrase, à gauche, à la largeur
 * d'un message de fil. Le geste vient juste après. Le trajet, la référence
 * et la ligne technique forment le reçu, en dessous. Pas de carte : le vide
 * autour est la conversation qui n'est plus là.
 */
function FailurePage({
  title,
  description,
  tone,
  path,
  facts,
  reference,
  action,
  art,
  className,
  isMobile,
}: {
  title: string;
  description: string;
  tone: FailureToneClasses;
  path: { shape: FailurePathShape; label: string } | null;
  facts: ReadonlyArray<FailureFact>;
  reference: string | null;
  action?: ReactNode;
  art?: ReactNode;
  className?: string;
  isMobile: boolean;
}) {
  return (
    <section
      role="alert"
      className={cn(
        "flex w-full min-h-0 flex-1 flex-col items-start justify-center",
        // With an illustration the text keeps its column and the art takes
        // the right of the page on a wide screen, above the text on a phone.
        art ? "gap-8 md:flex-row-reverse md:items-center md:justify-center md:gap-16" : undefined,
        "px-6 pt-[max(3rem,env(safe-area-inset-top))] pb-[max(3rem,env(safe-area-inset-bottom))] sm:px-12",
        className,
      )}
    >
      {art ?? null}
      <div className="flex w-full max-w-[26rem] flex-col items-start gap-5">
        <div className="flex flex-col gap-3">
          <h1 className="text-balance text-3xl font-semibold tracking-tight text-foreground">{title}</h1>
          <p className="max-w-[34ch] text-base leading-6 text-muted-foreground">{description}</p>
        </div>
        {action ? (
          <div
            className={cn(
              "flex gap-2",
              isMobile ? "w-full flex-col [&>*]:w-full" : "flex-row flex-wrap",
            )}
          >
            {action}
          </div>
        ) : null}
        {path || reference || facts.length > 0 ? (
          <div className="flex flex-col items-start gap-3">
            {path ? <FailurePath shape={path.shape} label={path.label} accent={tone.accent} /> : null}
            {reference ? <Reference value={reference} button={BUTTON.secondary} align="start" /> : null}
            {facts.length > 0 ? <FailureFacts facts={facts} tone={tone} /> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function FailureFacts({ facts, tone }: { facts: ReadonlyArray<FailureFact>; tone: FailureToneClasses }) {
  return (
    <dl className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-[11px] text-muted-foreground">
      {facts.map(({ label, value, status }) => (
        <div
          key={label}
          className={cn(
            "flex items-center gap-1.5",
            status ? cn("rounded-md border px-1.5 py-0.5", tone.chip) : undefined,
          )}
        >
          <dt className={status ? undefined : "opacity-70"}>{label}</dt>
          <dd className={status ? "font-semibold" : undefined}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Le trajet, dessiné. `role="img"` avec la phrase de la nature en `aria-label` :
 * un lecteur d'écran entend « la requête n'est pas partie » plutôt que d'épeler
 * les segments un à un.
 *
 * Chaque étape est une pastille ; l'étape où ça s'arrête prend la teinte de la
 * nature, une étape jamais atteinte reste en pointillé. Le trait entre deux
 * pastilles dit si le lien a été franchi.
 */
function FailurePath({ shape, label, accent }: { shape: FailurePathShape; label: string; accent: string }) {
  const { t } = useFallbackT();
  const stop = shape.hops.length - 1;
  return (
    <p
      role="img"
      aria-label={label}
      className="flex items-center py-1 font-mono text-[11px] leading-none"
    >
      {shape.hops.map((hop, index) => {
        const reached = index < stop || shape.crossedIntoStop;
        const isStop = index === stop;
        return (
          <Fragment key={hop}>
            {index > 0 ? <PathSegment crossed={reached} /> : null}
            <span
              className={cn(
                "rounded-full border px-2.5 py-1",
                // Ce qui a marché est vert ; l'étape qui a répondu par un
                // refus ou une panne prend le ton ; une étape jamais atteinte
                // reste en pointillé, sans couleur : elle n'a rien fait.
                isStop && reached
                  ? cn("border-current font-medium", accent)
                  : reached
                    ? "border-pos-700/40 bg-pos-soft text-pos-700"
                    : "border-dashed border-border text-muted-foreground/60",
              )}
            >
              {t(HOP_LABELS[hop])}
            </span>
          </Fragment>
        );
      })}
    </p>
  );
}

/**
 * Un lien franchi est un trait plein vert ; un lien non franchi est une
 * coupure rouge : c'est là que ça casse, quelle que soit la nature.
 */
function PathSegment({ crossed }: { crossed: boolean }) {
  if (crossed) return <span aria-hidden className="block h-px w-6 bg-pos-700/40" />;
  return (
    <span aria-hidden className="flex items-center gap-1 text-destructive-text">
      <span className="block h-0 w-2.5 border-t border-dashed border-current" />
      <span className="text-[10px] leading-none">×</span>
      <span className="block h-0 w-2.5 border-t border-dashed border-current" />
    </span>
  );
}

/**
 * La référence, quand la transmettre est le geste. Elle sort de la ligne
 * technique pour devenir sélectionnable d'un clic et copiable d'un geste :
 * c'est le seul contenu de l'écran qu'on recopie ailleurs.
 */
function Reference({
  value,
  button,
  align = "center",
}: {
  value: string;
  button: string;
  align?: "start" | "center";
}) {
  const { t } = useFallbackT();
  const start = align === "start";
  return (
    <div className={cn("flex w-full flex-col gap-2 pt-1", start ? "items-start" : "items-center")}>
      <p className={cn("max-w-[46ch] text-xs leading-5 text-muted-foreground", start ? "text-left" : "text-center")}>
        {t("errorState.transmit")}
      </p>
      <div className={cn("flex max-w-full flex-wrap gap-2", start ? "items-center justify-start" : "items-center justify-center")}>
        <code className="min-w-0 max-w-full select-all truncate rounded-md border border-border bg-surface-sunken/60 px-2.5 py-1.5 font-mono text-xs leading-5">
          {value}
        </code>
        <CopyButton
          value={value}
          copyLabel={t("errorState.copyReference")}
          copiedLabel={t("errorState.referenceCopied")}
          className={cn(button, "shrink-0 px-2.5 py-1 text-xs")}
          copiedClassName={cn(BUTTON.success, "shrink-0 px-2.5 py-1 text-xs")}
        />
      </div>
    </div>
  );
}
