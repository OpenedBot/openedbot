import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { cn } from "@openedbot/browser-ui-kit";
import { BotEngine } from "@openedbot/browser-face/bloub/engine";
import type { BotFrame } from "@openedbot/browser-face/bloub/engine";
import { NOTIF_BLUE } from "@openedbot/browser-face/bloub/decor";
import { mixHex } from "@openedbot/browser-face/bloub/skins";
import { DEMI_VIEWBOX, RAYON } from "@openedbot/browser-face/bloub/repere";
import { memeArbre, poser } from "../lib/faces/face-frame";

/**
 * Le galet du foyer : même montage que bloub `#etat=orbit&stop` : état
 * `orbit`, départ `frozen-at=1.2`, une passe
 * puis la pose tient. Le viewBox 158 loge les anneaux. Le papier sous le corps
 * occulte les traces qui passeraient par les yeux, comme chez bloub.
 *
 * `prefers-reduced-motion` fige la frame 1.2. Le regard suit le pointeur une
 * fois l'orbite relâchée, pas pendant : les yeux y filent déjà autour de la
 * sphère.
 */
/** `#etat=orbit&stop` : même frame que les pastilles bloub (`frozen-at=1.2`). */
const BOOT_ORBIT_FROZEN_AT = 1.2;
const BOOT_ORBIT_INK = "#0a0a0c";
const LOOK_AFTER = 3.2;

export function SalonOrbit({ className }: { className?: string }) {
  const uid = useId();
  const engineRef = useRef<BotEngine | null>(null);
  if (!engineRef.current) engineRef.current = new BotEngine(RAYON, "orbit");
  const engine = engineRef.current;
  const clockRef = useRef(BOOT_ORBIT_FROZEN_AT);
  const svgRef = useRef<SVGSVGElement>(null);
  const holeBodyRef = useRef<SVGPathElement>(null);
  const bodyRef = useRef<SVGPathElement>(null);
  const eyeRefs = useRef<Array<SVGPathElement | null>>([]);
  // `sample(t, true)` : le contour reste en cache dans le moteur, la dérive et
  // la respiration passent par `bodyTransform`. Une fois l'orbite passée,
  // l'arbre ne change plus et chaque image se réduit à quelques attributs
  // (`livrer`), comme les pastilles (`bloub-bot.tsx`). Avant, un `setFrame`
  // par image rendait tout le SVG par React, indéfiniment : environ 30 Mo/s
  // d'allocations sur le foyer, et le ramasse-miettes qui hachait la page.
  const [frame, setFrame] = useState<BotFrame>(() => engine.sample(BOOT_ORBIT_FROZEN_AT, true));
  const frameRef = useRef(frame);
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false,
  );

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  // Le galet ne vit que visible. Au téléphone la page défile et le galet part
  // sous l'en-tête : sans ça, la boucle rAF + `setFrame` continuait à 60 fps
  // pour un SVG que personne ne voit : la page d'accueil vidait la batterie.
  // À la reprise, l'horloge repart d'où elle s'est arrêtée : l'orbite ne se
  // rejoue pas, la pose tient.
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const node = svgRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setVisible(entry.isIntersecting);
      },
      { threshold: 0 },
    );
    io.observe(node);
    return () => io.disconnect();
  }, []);

  const peindre = (image: BotFrame) => {
    for (const corps of [holeBodyRef.current, bodyRef.current]) {
      if (corps) poser(corps, "transform", image.bodyTransform);
    }
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

  // Après chaque rendu d'arbre, la pose est reposée : React ne la porte pas.
  useLayoutEffect(() => {
    peindre(frameRef.current);
  });

  useEffect(() => {
    if (reduced) {
      livrer(engine.sample(BOOT_ORBIT_FROZEN_AT, true));
      return;
    }
    if (!visible) return;
    let raf = 0;
    let origin = -1;
    const resumeAt = clockRef.current;
    const tick = (ms: number) => {
      raf = requestAnimationFrame(tick);
      if (origin < 0) origin = ms;
      clockRef.current = resumeAt + (ms - origin) / 1000;
      livrer(engine.sample(clockRef.current, true));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // `livrer` ne lit que des refs : la mettre en dépendance relancerait la
    // boucle à chaque rendu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, reduced, visible]);

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (reduced || event.pointerType !== "mouse") return;
    if (clockRef.current < LOOK_AFTER) return;
    const node = svgRef.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return;
    const yaw = ((event.clientX - (box.left + box.width / 2)) / (box.width / 2)) * 38;
    const pitch = (-(event.clientY - (box.top + box.height / 2)) / (box.height / 2)) * 22;
    engine.setLook({ yaw, pitch, mix: 1, spin: 0, wander: 0 }, clockRef.current);
  };

  const onPointerLeave = () => {
    if (reduced || clockRef.current < LOOK_AFTER) return;
    engine.setLook(null, clockRef.current);
  };

  const maskId = `${uid}-mask`;
  const holeId = `${uid}-hole`;
  const ink = BOOT_ORBIT_INK;
  const d = DEMI_VIEWBOX;

  const dotAttrs = (dot: BotFrame["dots"][number]) => {
    const fill = dot.color ?? (dot.depth === undefined ? ink : mixHex("#888888", ink, dot.depth));
    return { fill, opacity: dot.opacity };
  };

  return (
    <svg
      ref={svgRef}
      viewBox={`${-d} ${-d} ${d * 2} ${d * 2}`}
      aria-hidden
      className={cn("salon-orbit", className)}
      xmlns="http://www.w3.org/2000/svg"
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      <defs>
        <mask id={holeId} maskUnits="userSpaceOnUse" x={-d} y={-d} width={d * 2} height={d * 2}>
          <path ref={holeBodyRef} d={frame.bodyPath} fill="#fff" />
        </mask>
        <mask id={maskId} maskUnits="userSpaceOnUse" x={-d} y={-d} width={d * 2} height={d * 2}>
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

      <rect x={-d} y={-d} width={d * 2} height={d * 2} fill="var(--salon-hole)" mask={`url(#${holeId})`} />
      <g opacity={frame.bodyAlpha} mask={`url(#${maskId})`}>
        <rect x={-d} y={-d} width={d * 2} height={d * 2} fill={ink} />
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

      <g fill="none" strokeLinecap="round">
        {frame.arcs.map((arc) => (
          <path key={`f${arc.id}`} d={arc.front} stroke={`url(#${uid}-${arc.id})`} strokeWidth={arc.width} opacity={arc.opacity} />
        ))}
      </g>
    </svg>
  );
}
