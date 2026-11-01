import { cn } from "@openedbot/browser-ui-kit";
import { defaultFaceFor, type BotFaceSpec } from "@openedbot/contracts-api";
import {
  BLINK_LID_SCALE_X,
  BLINK_LID_SCALE_Y,
  defaultArtworkFor,
  resolveBotArtwork,
  resolveBotArtworkEyes,
} from "@openedbot/browser-face/artworks";
import type { BotArtworkSpec } from "@openedbot/browser-face/artworks";
import { resolveFace } from "@openedbot/browser-face/presets";
import { useFaceMotion } from "../lib/faces/face-motion";
import { BloubBotFace } from "./bloub-bot";

/**
 * Le rythme de clignement d'UN avatar : dérivé de la graine pour que dix
 * pastilles dans la barre latérale ne clignent pas d'un seul homme, et stable
 * pour qu'un re-rendu ne fasse pas sauter la paupière en plein cycle.
 */
function blinkRhythmFor(seed: string): { durationMs: number; delayMs: number } {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (Math.imul(hash, 31) + seed.charCodeAt(index)) >>> 0;
  }
  return { durationMs: 3800 + (hash % 1600), delayMs: -(hash % 4400) };
}

/**
 * L'artwork WEBP d'un bot, avec ses paupières et sa respiration.
 *
 * Servi depuis `public/bots/` (les mêmes fichiers que le mobile). Tout le
 * mouvement est du pur CSS (`bot-artwork-blink`, `bot-artwork-idle`) : pas de
 * boucle JS par pastille, la géométrie mesurée de
 * `@openedbot/browser-face/artworks` posée en pourcentages suit n'importe quelle
 * taille de conteneur, et le compositeur fait le reste.
 *
 * La respiration est le `bob` de grokbot : sans elle, un artwork figé entre
 * deux clignements est une image, pas un personnage. Elle prend le rythme
 * dérivé de la graine, comme la paupière, pour la même raison.
 */
function BotArtworkFace({
  name,
  seed,
  artwork,
  animated,
  className,
}: {
  name: string;
  seed: string;
  artwork: BotArtworkSpec;
  animated: boolean;
  className?: string;
}) {
  const eyes = resolveBotArtworkEyes(artwork.id);
  const rhythm = blinkRhythmFor(seed);
  return (
    <span
      aria-hidden
      data-face-animated={animated ? "true" : "false"}
      className={cn(
        "relative inline-block shrink-0",
        artwork.portrait && "overflow-hidden rounded-2xl",
        className,
      )}
    >
      <img
        src={`/bots/bot-${artwork.id}.webp`}
        alt={name}
        draggable={false}
        className={cn(
          "size-full",
          artwork.portrait ? "object-cover" : "object-contain",
          animated && "bot-artwork-idle",
        )}
        style={animated ? { animationDelay: `${rhythm.delayMs}ms` } : undefined}
      />
      {eyes?.eyes.map((eye, index) => (
        <span
          key={index}
          className={cn("pointer-events-none absolute rounded-full", animated && "bot-artwork-lid")}
          style={{
            left: `${(eye.cx - (eye.w * BLINK_LID_SCALE_X) / 2) * 100}%`,
            top: `${(eye.cy - (eye.h * BLINK_LID_SCALE_Y) / 2) * 100}%`,
            width: `${eye.w * BLINK_LID_SCALE_X * 100}%`,
            height: `${eye.h * BLINK_LID_SCALE_Y * 100}%`,
            backgroundColor: eyes.lid,
            animationDuration: `${rhythm.durationMs}ms`,
            animationDelay: `${rhythm.delayMs}ms`,
            // Sans animation, la paupière n'est pas au repos : elle est
            // fermée. C'est l'image qui la relève, donc figer l'artwork sans
            // l'effacer poserait deux pastilles de peau sur les yeux.
            opacity: animated ? undefined : 0,
          }}
        />
      ))}
    </span>
  );
}

/**
 * Le visage d'un bot : l'artwork généré quand il en a un, la mascotte
 * OpenBotSmile sinon.
 *
 * C'est l'équivalent de la souris d'OpenMausBot : ce qui distingue deux
 * conversations dans la liste, c'est d'abord une frimousse, pas deux initiales
 * grises. Un bot qui n'a RIEN choisi reçoit un artwork stable dérivé de son
 * identifiant : même hachage salé que le mobile, même tête sur les deux
 * clients. Seul un visage vectoriel explicitement choisi dans l'éditeur
 * (spécification non nulle sans `artwork`) garde le rendu SVG : ce choix vient
 * de l'utilisateur et prime.
 *
 * Les deux visages VIVENT, partout, par défaut, c'est le contrat de grokbot,
 * dont l'avatar n'expose que des opt-out. Ce qui l'interdisait n'était pas le
 * coût du mouvement mais son montage : un `setState` par image et par
 * pastille. Le corps classique passe maintenant par une horloge partagée et
 * cinq écritures d'attributs (`bloub-bot.tsx`), l'artwork par deux animations
 * CSS compositées.
 *
 * Le silence se déclare par sous-arbre : `FaceMotionProvider`, posé une fois
 * par le cadre des réglages, ou par un `animated` explicite, qui prime.
 *
 * La taille se donne par `className` (`size-10`, `size-5`…) : le rendu suit
 * son conteneur.
 */
export function BotFace({
  name,
  seed,
  face,
  className,
  animated,
}: {
  name: string;
  /** L'identifiant, pas le nom : le visage dérivé ne doit pas bouger au renommage. */
  seed: string;
  face?: BotFaceSpec | null;
  className?: string;
  /** Force la vie au repos, ou l'éteint. Par défaut : ce que dit le sous-arbre. */
  animated?: boolean;
}) {
  const contexte = useFaceMotion();
  const vivant = animated ?? contexte;
  const customSrc = face?.artwork?.startsWith("/api/") ? face.artwork : null;
  const artwork = customSrc ? null : resolveBotArtwork(face?.artwork) ?? (face ? null : defaultArtworkFor(seed));

  if (customSrc) {
    return (
      <span aria-hidden className={cn("relative inline-block shrink-0 overflow-hidden rounded-full", className)}>
        <img src={customSrc} alt={name} draggable={false} className="size-full object-cover" />
      </span>
    );
  }

  if (artwork) {
    return (
      <BotArtworkFace name={name} seed={seed} artwork={artwork} animated={vivant} className={className} />
    );
  }

  const resolved = resolveFace(face ?? defaultFaceFor(seed), seed);
  return <BloubBotFace face={resolved} seed={seed} animated={vivant} className={className} />;
}
