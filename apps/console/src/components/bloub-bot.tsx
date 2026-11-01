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
} from "../lib/face-clock";
import { memeArbre, poser } from "../lib/face-frame";

/**
 * Demi-viewBox de l'avatar. Plus serré que celui de bloub (158) : sa marge
 * loge les anneaux de l'orbite, or l'état de repos n'en a pas, et une pastille
 * de 40 px n'a pas de place à perdre. Les formes montent à 1,15 × le rayon
 * (squircle), la respiration et la dérive restent sous le pourcent.
 */
const DEMI = 120;

/**
 * Le visage classique d'un bot, rendu par le moteur bloub (`@openedbot/browser-face/
 * bloub`, MIT) : le port React de son composant Vue, réduit à l'usage
 * avatar : l'état de repos, avec l'expression choisie.
 *
 * Il vit par défaut, et partout. Ce qui l'a longtemps interdit n'était pas le
 * moteur : une image coûte 37 µs, dont 26 pour la seule reconstruction du
 * contour, que `sample(t, true)` supprime, mais le `setState` par image :
 * trente pastilles, c'était trente rendus React et trente chemins de 2,4 ko
 * reparsés par le navigateur, soixante fois par seconde.
 *
 * Ici React ne rend que l'ARBRE, et seulement quand il change. La pose passe
 * par cinq écritures d'attributs, depuis une horloge partagée par tout le
 * produit (`face-clock.ts`) qui ne tourne que pour les visages réellement à
 * l'écran. C'est le montage de grokbot, dont la boucle d'avatar n'écrit elle
 * aussi que deux `transform` et ne touche jamais l'état React.
 *
 * `animated={false}` fige l'image sur la pose du visage à cet instant : les
 * réglages, les vignettes d'un sélecteur. Le moteur étant une fonction pure du
 * temps, cette pose reste reproductible pour une graine donnée.
 *
 * La taille se donne par `className` (`size-10`, `size-5`…) : le rendu suit
 * son conteneur.
 */
export function BloubBotFace({
  face,
  seed,
  animated = true,
  className,
}: {
  face: ResolvedFace;
  /** L'identifiant : il donne au visage sa phase propre, pas seulement sa forme. */
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

  // Le temps est partagé ; c'est la PHASE qui est propre à ce visage. Sans
  // elle, toutes les pastilles d'une liste cligneraient d'un seul homme.
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
    // `livrer` et `peindre` lisent des refs : les recréer à chaque rendu ne
    // change rien à ce qu'ils font, les mettre en dépendance relancerait le
    // morphing du visage à chaque image.
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

  // Après chaque rendu d'arbre, la pose est reposée : React ne la porte pas.
  useLayoutEffect(() => {
    peindre(frameRef.current);
  });

  const ink = face.color.hex;
  const maskId = `${uid}-mask`;

  const dotAttrs = (dot: BotFrame["dots"][number]) => {
    // `depth` demande un mélange avec le fond ; le fond est une variable CSS,
    // pas un hex : on fond alors vers un gris moyen, le cas ne survient que
    // hors repos (particules de l'éclatement).
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

      {/* moitié arrière des orbites : dessinée avant le corps, donc occultée */}
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

      {/* Écart assumé avec bloub : pas de fond opaque sous le corps. Chez lui
          il occulte les anneaux dessinés derrière quand ils passent sous les
          trous des yeux ; l'état de repos n'en a pas, et des trous vraiment
          transparents suivent n'importe quel fond (survol, sélection, thème). */}
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

      {/* moitié avant des orbites */}
      <g fill="none" strokeLinecap="round">
        {frame.arcs.map((arc) => (
          <path key={`f${arc.id}`} d={arc.front} stroke={`url(#${uid}-${arc.id})`} strokeWidth={arc.width} opacity={arc.opacity} />
        ))}
      </g>
    </svg>
  );
}
