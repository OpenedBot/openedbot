import { lazy, Suspense } from "react";
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
import { isMascotFace } from "@openedbot/browser-face/mascot";
import { resolveFace } from "@openedbot/browser-face/presets";
import { useFaceMotion } from "../lib/faces/face-motion";
import { BloubBotFace } from "./bloub-bot";

// The cat's drawing is a 9 KB outline: it loads with the first cat shown,
// never in the first load (console bundle budget).
const MascotFace = lazy(() => import("./mascot-face").then((module) => ({ default: module.MascotFace })));

/**
 * ONE avatar's blink rhythm: derived from the seed so that ten
 * chips in the sidebar do not blink as one, and stable
 * so a re-render does not jump the eyelid mid-cycle.
 */
function blinkRhythmFor(seed: string): { durationMs: number; delayMs: number } {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (Math.imul(hash, 31) + seed.charCodeAt(index)) >>> 0;
  }
  return { durationMs: 3800 + (hash % 1600), delayMs: -(hash % 4400) };
}

/**
 * A bot's WEBP artwork, with its eyelids and its breathing.
 *
 * Served from `public/bots/` (the same files as mobile). All the
 * motion is pure CSS (`bot-artwork-blink`, `bot-artwork-idle`): no
 * JS loop per chip, the measured geometry of
 * `@openedbot/browser-face/artworks` set in percentages follows any
 * container size, and the compositor does the rest.
 *
 * Breathing is the reference app's `bob`: without it, an artwork frozen between
 * two blinks is an image, not a character. It takes the rhythm
 * derived from the seed, like the eyelid, for the same reason.
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
            // Without animation, the eyelid is not at rest: it is
            // closed. The image is what lifts it, so freezing the artwork without
            // clearing it would lay two skin chips on the eyes.
            opacity: animated ? undefined : 0,
          }}
        />
      ))}
    </span>
  );
}

/**
 * A bot's face: the cat (`shape: "chat"`) when it wears one, the generated
 * artwork when it has one, the smiling mascot otherwise.
 *
 * It is the equivalent of the reference app's mouse: what distinguishes two
 * conversations in the list is a face first, not two grey
 * initials. A bot that has chosen NOTHING receives a stable artwork derived from its
 * identifier: the same salted hash as mobile, the same head on both
 * clients. Only a vector face explicitly chosen in the editor
 * (a non-null specification without `artwork`) keeps the SVG render: that choice comes
 * from the user and wins.
 *
 * Both faces LIVE, everywhere, by default; that is the reference app's contract,
 * whose avatar exposes only opt-outs. What forbade it was not the
 * cost of the motion but its wiring: a `setState` per frame and per
 * chip. The classic body now goes through a shared clock and
 * five attribute writes (`bloub-bot.tsx`), the artwork through two composited
 * CSS animations.
 *
 * Stillness is declared per subtree: `FaceMotionProvider`, placed once
 * by the settings frame, or by an explicit `animated`, which wins.
 *
 * Size is given by `className` (`size-10`, `size-5`…): the render follows
 * its container.
 */
export function BotFace({
  name,
  seed,
  face,
  className,
  animated,
}: {
  name: string;
  /** The identifier, not the name: the derived face must not move on rename. */
  seed: string;
  face?: BotFaceSpec | null;
  className?: string;
  /** Forces the idle life, or turns it off. By default: what the subtree says. */
  animated?: boolean;
}) {
  const contexte = useFaceMotion();
  const vivant = animated ?? contexte;
  if (face && isMascotFace(face)) {
    return (
      <Suspense fallback={<span aria-hidden className={cn("relative inline-block shrink-0", className)} />}>
        <MascotFace face={face} animated={vivant} rhythm={blinkRhythmFor(seed)} className={className} />
      </Suspense>
    );
  }
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
