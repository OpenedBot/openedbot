import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@openedbot/browser-ui-kit";
import { BotEngine } from "@openedbot/browser-face/bloub/engine";
import type { BotFrame } from "@openedbot/browser-face/bloub/engine";
import { NOTIF_BLUE } from "@openedbot/browser-face/bloub/decor";
import { mixHex } from "@openedbot/browser-face/bloub/skins";
import { RAYON } from "@openedbot/browser-face/bloub/repere";
import type { ResolvedFace } from "@openedbot/browser-face/presets";
import {
  abonnerAuTemps,
  mouvementRefuse,
  observerLeVisage,
  phaseDuVisage,
  tempsDesVisages,
} from "../lib/faces/face-clock";
import { memeArbre, poser } from "../lib/faces/face-frame";

/**
 * Half viewBox of the avatar. Tighter than bloub's (158): its margin
 * holds the orbit rings, but the idle state has none, and a 40 px
 * chip has no room to spare. Shapes go up to 1.15 × the radius
 * (squircle); breathing and drift stay under one percent.
 */
const DEMI = 120;

/**
 * A bot's classic face, drawn by the bloub engine (`@openedbot/browser-face/
 * bloub`, MIT): the React port of its Vue component, reduced to avatar
 * use: the idle state, with the chosen expression.
 *
 * It lives by default, and everywhere. What long forbade it was not the
 * engine: one frame costs 37 µs, 26 of them for rebuilding the
 * outline alone, which `sample(t, true)` drops, but the `setState` per frame:
 * thirty chips meant thirty React renders and thirty 2.4 KB paths
 * reparsed by the browser, sixty times a second.
 *
 * Here React renders only the TREE, and only when it changes. The pose goes
 * through five attribute writes, from a clock shared by the whole
 * product (`face-clock.ts`) that runs only for faces actually on
 * screen. It is the reference app's setup, whose avatar loop also writes
 * only two `transform`s and never touches React state.
 *
 * `animated={false}` freezes the frame on the face's pose at that instant: the
 * settings, a picker's thumbnails. The engine being a pure function of
 * time, that pose stays reproducible for a given seed.
 *
 * Size is given by `className` (`size-10`, `size-5`…): the render follows
 * its container.
 */
export function BloubBotFace({
  face,
  seed,
  animated = true,
  className,
}: {
  face: ResolvedFace;
  /** The identifier: it gives the face its own phase, not only its shape. */
  seed: string;
  animated?: boolean;
  className?: string;
}) {
  const uid = useId();
  const engineRef = useRef<BotEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new BotEngine(RAYON, "idle", face.shape.radii, face.expression);
  }
  const engine = engineRef.current;

  // Time is shared; it is the PHASE that belongs to this face. Without
  // it, every chip in a list would blink as one.
  const phase = useMemo(() => phaseDuVisage(seed), [seed]);
  const clockRef = useRef(tempsDesVisages() + phase);

  const hostRef = useRef<SVGSVGElement>(null);
  const bodyRef = useRef<SVGPathElement>(null);
  const eyeRefs = useRef<Array<SVGPathElement | null>>([]);

  const [frame, setFrame] = useState<BotFrame>(() => engine.sample(clockRef.current, true));
  const frameRef = useRef(frame);
  const [aLEcran, setALEcran] = useState(false);

  const vivant = animated && aLEcran && !mouvementRefuse();

  const peindre = (image: BotFrame) => {
    const corps = bodyRef.current;
    if (corps) poser(corps, "transform", image.bodyTransform);
    for (let index = 0; index < image.eyes.length; index += 1) {
      const oeil = image.eyes[index]!;
      const node = eyeRefs.current[index];
      if (!node) continue;
      poser(node, "transform", oeil.matrix);
      poser(node, "opacity", oeil.alpha.toFixed(3));
    }
  };

  const livrer = (image: BotFrame) => {
    const avant = frameRef.current;
    frameRef.current = image;
    if (memeArbre(avant, image)) peindre(image);
    else setFrame(image);
  };

  useEffect(() => {
    const node = hostRef.current;
    if (!node) return;
    return observerLeVisage(node, setALEcran);
  }, []);

  useEffect(() => {
    engine.setShape(face.shape.radii, clockRef.current);
    engine.setExpression(face.expression, clockRef.current);
    livrer(engine.sample(clockRef.current, true));
    // `livrer` and `peindre` read refs: recreating them on every render changes
    // nothing about what they do; putting them in the dependency list would restart
    // the face's morphing on every frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, face.shape, face.expression]);

  useEffect(() => {
    if (!vivant) return;
    return abonnerAuTemps((secondes) => {
      clockRef.current = secondes + phase;
      livrer(engine.sample(clockRef.current, true));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, vivant, phase]);

  // After every tree render, the pose is applied again: React does not carry it.
  useLayoutEffect(() => {
    peindre(frameRef.current);
  });

  const ink = face.color.hex;
  const maskId = `${uid}-mask`;

  const dotAttrs = (dot: BotFrame["dots"][number]) => {
    // `depth` asks for a blend with the background; the background is a CSS variable,
    // not a hex: one then blends toward a mid grey. The case only happens
    // outside idle (burst particles).
    const fill = dot.color ?? (dot.depth === undefined ? ink : mixHex("#888888", ink, dot.depth));
    return { fill, opacity: dot.opacity };
  };

  return (
    <svg
      ref={hostRef}
      viewBox={`${-DEMI} ${-DEMI} ${DEMI * 2} ${DEMI * 2}`}
      aria-hidden
      data-face-animated={vivant ? "true" : "false"}
      className={cn("shrink-0", className)}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x={-DEMI} y={-DEMI} width={DEMI * 2} height={DEMI * 2}>
          <path ref={bodyRef} d={frame.bodyPath} fill="#fff" />
          {frame.eyes.map((eye, index) => (
            <path
              key={index}
              ref={(node) => {
                eyeRefs.current[index] = node;
              }}
              d={eye.d}
              fill="#000"
            />
          ))}
          {frame.notch ? <circle cx={frame.notch.x} cy={frame.notch.y} r={frame.notch.r} fill="#000" /> : null}
        </mask>
        {frame.arcs.map((arc) => (
          <linearGradient
            key={arc.id}
            id={`${uid}-${arc.id}`}
            gradientUnits="userSpaceOnUse"
            x1={arc.grad.x1}
            y1={arc.grad.y1}
            x2={arc.grad.x2}
            y2={arc.grad.y2}
          >
            {arc.grad.stops.map((color, index) => (
              <stop key={index} offset={index / (arc.grad.stops.length - 1)} stopColor={color} />
            ))}
          </linearGradient>
        ))}
      </defs>

      {/* back half of the orbits: drawn before the body, so occluded */}
      <g fill="none" strokeLinecap="round">
        {frame.arcs.map((arc) => (
          <path key={`b${arc.id}`} d={arc.back} stroke={`url(#${uid}-${arc.id})`} strokeWidth={arc.width} opacity={arc.opacity} />
        ))}
      </g>

      {frame.dotsBehind
        ? frame.dots.map((dot, index) =>
            dot.d ? (
              <path key={`pb${index}`} {...dotAttrs(dot)} d={dot.d} transform={`translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${RAYON})`} />
            ) : (
              <circle key={`pb${index}`} {...dotAttrs(dot)} cx={dot.x} cy={dot.y} r={dot.r} />
            ),
          )
        : null}

      {/* Deliberate gap with bloub: no opaque background under the body. There
          it hides the rings drawn behind when they pass under the
          eye holes; the idle state has none, and holes that are truly
          transparent follow any background (hover, selection, theme). */}
      <g opacity={frame.bodyAlpha} mask={`url(#${maskId})`}>
        <rect x={-DEMI} y={-DEMI} width={DEMI * 2} height={DEMI * 2} fill={ink} />
      </g>

      {!frame.dotsBehind
        ? frame.dots.map((dot, index) =>
            dot.d ? (
              <path key={`pf${index}`} {...dotAttrs(dot)} d={dot.d} transform={`translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${RAYON})`} />
            ) : (
              <circle key={`pf${index}`} {...dotAttrs(dot)} cx={dot.x} cy={dot.y} r={dot.r} />
            ),
          )
        : null}

      {frame.notif ? <circle cx={frame.notif.x} cy={frame.notif.y} r={frame.notif.r} fill={NOTIF_BLUE} /> : null}

      {/* front half of the orbits */}
      <g fill="none" strokeLinecap="round">
        {frame.arcs.map((arc) => (
          <path key={`f${arc.id}`} d={arc.front} stroke={`url(#${uid}-${arc.id})`} strokeWidth={arc.width} opacity={arc.opacity} />
        ))}
      </g>
    </svg>
  );
}
