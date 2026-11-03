import * as React from "react";
import { cn } from "../../lib/utils";
import { RollText } from "./roll-text";

/**
 * L'état « l'agent travaille », posé au-dessus du composer pendant qu'une
 * réponse se fabrique. Porté du bloc `agent-thinking` de BoardUI.
 *
 * Quatre indicateurs :
 * - `wave`     grille de points qu'un front diagonal traverse en biais
 * - `spin`     même grille, tête lumineuse qui tourne dans le sens horaire
 * - `stars`    étincelles qui scintillent en décalé
 * - `infinity` comète qui parcourt un huit
 *
 * Chacun s'accompagne d'un libellé qui scintille et d'un temps écoulé. Sous
 * `prefers-reduced-motion`, tout retombe sur un rendu fixe (voir `app.css`).
 *
 * Écart assumé avec l'amont : le temps écoulé part d'une date fournie par
 * l'appelant, jamais du montage du composant. Un fil relu après coup doit
 * afficher la durée du run, pas celle de l'affichage.
 */

export type AgentThinkingVariant = "wave" | "spin" | "stars" | "infinity";
export type AgentThinkingTone = "subtle" | "default" | "primary" | "accent";

export type AgentThinkingProps = {
  variant?: AgentThinkingVariant;
  /** Le libellé d'état, « Réfléchit » ou « Cherche dans la doc ». */
  label: string;
  /** Ton de l'indicateur et du libellé. Défaut propre à chaque variante. */
  tone?: AgentThinkingTone;
  /** Le reflet qui traverse le libellé. */
  shimmer?: boolean;
  /** Date ISO du départ. Posée, le temps écoulé s'affiche après le libellé. */
  startedAt?: string | null;
  className?: string;
};

const TONE_COLORS: Record<AgentThinkingTone, string> = {
  subtle: "var(--color-muted-foreground)",
  default: "var(--color-muted-foreground)",
  primary: "var(--color-foreground)",
  accent: "var(--color-primary)",
};

const VARIANT_TONE: Record<AgentThinkingVariant, AgentThinkingTone> = {
  wave: "default",
  spin: "default",
  stars: "subtle",
  infinity: "default",
};

/* ---------------------------------------------------------------- points */

const DOTS_GRID = 3;
const DOTS_SIZE = 4;
const DOTS_GAP = 2;
const DOTS_TICK_MS = 80;
const DOTS_FADE_MS = 220;
const DOTS_TRAIL = 0.3;
const DOTS_MIN_OPACITY = 0.12;
const DOTS_PHASE_STEP = 1 / 8;

/** Première image, identique partout, et l'état de repos sans mouvement. */
const DOTS_SEED = [0.55, 0.3, 0.15, 0.85, 0.55, 0.3, 1, 0.85, 0.55];

/**
 * Où se situe chaque case le long du déplacement du motif, dans [0, 1).
 * Le scalaire de la vague est comprimé sous 1 pour que le bouclage se lise
 * comme un front qui sort de la grille puis y rentre. L'angle de la rotation
 * est cyclique de lui-même.
 */
function dotScalar(variant: "wave" | "spin", col: number, row: number): number {
  const m = DOTS_GRID - 1;
  if (variant === "wave") {
    return ((col + row) / (2 * m)) * (DOTS_GRID / (DOTS_GRID + 1));
  }
  const center = m / 2;
  return (Math.atan2(row - center, col - center) / (2 * Math.PI) + 1) % 1;
}

function dotOpacities(variant: "wave" | "spin", phase: number): number[] {
  return Array.from({ length: DOTS_GRID * DOTS_GRID }, (_, i) => {
    const s = dotScalar(variant, i % DOTS_GRID, Math.floor(i / DOTS_GRID));
    // Comète : tête vive sur le front, traîne qui s'éteint derrière.
    const behind = (phase - s + 1) % 1;
    const lit = Math.max(0, 1 - behind / DOTS_TRAIL) ** 1.5;
    return DOTS_MIN_OPACITY + (1 - DOTS_MIN_OPACITY) * lit;
  });
}

function DotsIndicator({ variant }: { variant: "wave" | "spin" }) {
  const [opacities, setOpacities] = React.useState<number[]>(DOTS_SEED);

  React.useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let phase = 0;
    const id = window.setInterval(() => {
      phase = (phase + DOTS_PHASE_STEP) % 1;
      setOpacities(dotOpacities(variant, phase));
    }, DOTS_TICK_MS);
    return () => window.clearInterval(id);
  }, [variant]);

  return (
    <span
      aria-hidden
      className="grid shrink-0"
      style={{ gridTemplateColumns: `repeat(${DOTS_GRID}, ${DOTS_SIZE}px)`, gap: DOTS_GAP }}
    >
      {opacities.map((opacity, i) => (
        <span
          key={i}
          className="rounded-[1px] bg-current"
          style={{
            width: DOTS_SIZE,
            height: DOTS_SIZE,
            opacity,
            transition: `opacity ${DOTS_FADE_MS}ms ease`,
          }}
        />
      ))}
    </span>
  );
}

/* --------------------------------------------------------------- étoiles */

const STAR_PERIOD_S = 1.4;
const STAR_SIZE = 14;
const STAR_LAYOUT = [
  { x: 50, y: 46, scale: 1 },
  { x: 18, y: 22, scale: 0.55 },
  { x: 82, y: 26, scale: 0.45 },
  { x: 78, y: 76, scale: 0.55 },
  { x: 22, y: 78, scale: 0.4 },
];
const STAR_PATH = "M12 0C13 7 17 11 24 12C17 13 13 17 12 24C11 17 7 13 0 12C7 11 11 7 12 0Z";

function StarsIndicator() {
  const box = STAR_SIZE * 1.5;
  return (
    <span
      aria-hidden
      className="ohb-agent-stars relative block shrink-0"
      style={{ width: box, height: box }}
    >
      {STAR_LAYOUT.map((star, i) => {
        const size = STAR_SIZE * star.scale;
        return (
          <svg
            key={i}
            viewBox="0 0 24 24"
            className="ohb-agent-star absolute"
            style={{
              width: size,
              height: size,
              left: `${star.x}%`,
              top: `${star.y}%`,
              marginLeft: -size / 2,
              marginTop: -size / 2,
              animationDuration: `${STAR_PERIOD_S}s`,
              animationDelay: `${(i * STAR_PERIOD_S * 0.7) / STAR_LAYOUT.length}s`,
            }}
          >
            <path d={STAR_PATH} fill="currentColor" />
          </svg>
        );
      })}
    </span>
  );
}

/* ---------------------------------------------------------------- infini */

const INFINITY_WIDTH = 32;
const INFINITY_TRAIL = 11;
const INFINITY_STROKE = 2.75;
const INFINITY_DURATION_S = 1.2;
const INFINITY_PATH = "M28 14C33 5 47 5 47 14C47 23 33 23 28 14C23 5 9 5 9 14C9 23 23 23 28 14Z";

function InfinityIndicator() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 56 28"
      className="shrink-0"
      // Le huit occupe x 9 à 47 d'une boîte large de 56 : à cette taille le
      // svg traîne 4 px de vide de chaque côté. On les reprend pour que le
      // libellé s'asseye sur l'écart réel de l'indicateur.
      style={{ width: INFINITY_WIDTH, height: INFINITY_WIDTH / 2, margin: "0 -4px" }}
    >
      <path
        d={INFINITY_PATH}
        fill="none"
        stroke="currentColor"
        strokeWidth={INFINITY_STROKE}
        opacity={0.15}
      />
      <path
        d={INFINITY_PATH}
        pathLength={100}
        fill="none"
        stroke="currentColor"
        strokeWidth={INFINITY_STROKE}
        strokeLinecap="round"
        strokeDasharray={`${INFINITY_TRAIL} ${100 - INFINITY_TRAIL}`}
        className="ohb-agent-comet"
        style={{ animationDuration: `${INFINITY_DURATION_S}s` }}
      />
    </svg>
  );
}

/* --------------------------------------------------------------- horloge */

/** Le temps écoulé depuis `startedAt`, au dixième comme en amont. */
function ElapsedTimer({ startedAt }: { startedAt: string }) {
  const origin = new Date(startedAt).getTime();
  const [elapsed, setElapsed] = React.useState(() =>
    Number.isFinite(origin) ? Math.max(0, (Date.now() - origin) / 1000) : 0,
  );

  React.useEffect(() => {
    if (!Number.isFinite(origin)) return;
    const tick = () => setElapsed(Math.max(0, (Date.now() - origin) / 1000));
    tick();
    const id = window.setInterval(tick, 100);
    return () => window.clearInterval(id);
  }, [origin]);

  if (!Number.isFinite(origin)) return null;
  return (
    // Hors de l'annonce du `role="status"` : un lecteur d'écran relirait la
    // durée à chaque dixième de seconde.
    <span aria-hidden="true" className="text-caption-1-regular font-mono tabular-nums text-muted-foreground">
      {formatElapsed(elapsed)}
    </span>
  );
}

/**
 * Sous la minute, le dixième de seconde, comme en amont. Au-delà, minutes et
 * secondes : un run d'agent dure parfois des minutes, et « 184.0s » ne se lit
 * plus.
 */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, "0")}`;
}

/* ------------------------------------------------------------ indicateur */

export function AgentThinking({
  variant = "wave",
  label,
  tone,
  shimmer = true,
  startedAt,
  className,
}: AgentThinkingProps) {
  const color = TONE_COLORS[tone ?? VARIANT_TONE[variant]];

  return (
    <div
      role="status"
      className={cn("flex items-center gap-2.5", className)}
      style={{ color, "--ohb-agent-tone": color } as React.CSSProperties}
    >
      {(variant === "wave" || variant === "spin") && <DotsIndicator variant={variant} />}
      {variant === "stars" && <StarsIndicator />}
      {variant === "infinity" && <InfinityIndicator />}
      {/* The label rolls to its next value (« Réfléchit » to « Cherche sur le
          web ») instead of jumping. The shimmer sits on each rolling line:
          it clips its gradient to its own text. */}
      <RollText value={label} className="text-body-medium" shimmer={shimmer} />

      {startedAt ? <ElapsedTimer startedAt={startedAt} /> : null}
    </div>
  );
}

/** Le libellé qui travaille, sans indicateur : le reflet le traverse seul. */
export function ShimmerLabel({
  children,
  tone = "default",
  className,
}: {
  children: React.ReactNode;
  tone?: AgentThinkingTone;
  className?: string;
}) {
  const color = TONE_COLORS[tone];
  return (
    <span
      className={cn("ohb-agent-label", className)}
      style={{ color, "--ohb-agent-tone": color } as React.CSSProperties}
    >
      {children}
    </span>
  );
}
