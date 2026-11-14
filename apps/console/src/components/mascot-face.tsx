import type { CSSProperties, ReactNode } from "react";
import { cn } from "@openedbot/browser-ui-kit";
import type { BotFaceSpec } from "@openedbot/contracts-api";
import { resolveMascot, type MascotAccessory, type MascotEyeStyle } from "@openedbot/browser-face/mascot";
import {
  MASCOT_BODY,
  MASCOT_EYES,
  MASCOT_EYE_H,
  MASCOT_EYE_W,
  MASCOT_VIEWBOX,
  mascotAccessoryInk,
} from "@openedbot/browser-face/mascot-art";

const STROKE = { fill: "none", strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** An 8-tooth gear outline around (0, 0), for Méca. */
function gearPath(outer: number, inner: number, teeth: number): string {
  const points: string[] = [];
  const step = (Math.PI * 2) / (teeth * 4);
  for (let index = 0; index < teeth * 4; index += 1) {
    const radius = index % 4 < 2 ? outer : inner;
    const angle = index * step - step / 2;
    points.push(`${(Math.cos(angle) * radius).toFixed(1)} ${(Math.sin(angle) * radius).toFixed(1)}`);
  }
  return `M${points.join(" L")}Z`;
}

const GEAR = gearPath(86, 64, 8);

/** A circular arc around (cx, cy), angles in degrees, y pointing down. */
function arc(cx: number, cy: number, radius: number, from: number, to: number): string {
  const point = (deg: number) => {
    const rad = (deg * Math.PI) / 180;
    return `${(cx + Math.cos(rad) * radius).toFixed(1)} ${(cy + Math.sin(rad) * radius).toFixed(1)}`;
  };
  return `M${point(from)} A ${radius} ${radius} 0 0 1 ${point(to)}`;
}

/** What sits BEHIND the body: stems that grow out of it. */
function behind(accessory: MascotAccessory | null, ink: string): ReactNode {
  switch (accessory) {
    case "antenna":
      return <path d="M500 320 Q 512 220 552 152" stroke={ink} strokeWidth={20} {...STROKE} />;
    case "sprout":
      return <path d="M500 320 Q 492 250 506 196" stroke={ink} strokeWidth={18} {...STROKE} />;
    default:
      return null;
  }
}

/** What sits IN FRONT of the body. */
function front(accessory: MascotAccessory | null, ink: string, body: string): ReactNode {
  const [left, right] = MASCOT_EYES;
  switch (accessory) {
    case "antenna":
      return <circle cx={556} cy={134} r={34} fill={ink} />;
    case "glasses":
      return (
        <g stroke={ink} strokeWidth={14} {...STROKE}>
          <ellipse cx={left.cx} cy={left.cy} rx={72} ry={112} />
          <ellipse cx={right.cx} cy={right.cy} rx={72} ry={112} />
          <path d={`M${left.cx + 72} ${left.cy - 14} Q ${(left.cx + right.cx) / 2} ${right.cy - 4} ${right.cx - 72} ${right.cy - 6}`} />
          <path d={`M${left.cx - 72} ${left.cy - 20} L ${left.cx - 150} ${left.cy - 34}`} />
        </g>
      );
    case "waves":
      // Two arcs off the right ear: the watcher listening.
      return (
        <g stroke={ink} strokeWidth={24} {...STROKE}>
          <path d={arc(760, 200, 96, -78, -22)} />
          <path d={arc(760, 200, 150, -74, -26)} />
        </g>
      );
    case "sprout":
      return (
        <g fill={ink}>
          <path d="M506 198 Q 446 140 410 176 Q 446 222 506 198 Z" />
          <path d="M506 198 Q 560 122 612 150 Q 584 208 506 198 Z" />
        </g>
      );
    case "headset":
      return (
        <g>
          <path d="M262 588 Q 330 728 512 702" stroke={ink} strokeWidth={18} {...STROKE} />
          <ellipse cx={236} cy={520} rx={50} ry={76} fill={ink} />
          <circle cx={524} cy={700} r={28} fill={ink} />
        </g>
      );
    case "gear":
      return (
        <g transform="translate(318 390)">
          <path d={GEAR} fill={ink} />
          <circle r={30} fill={body} />
        </g>
      );
    default:
      return null;
  }
}

function eye(style: MascotEyeStyle, cx: number, cy: number, className: string | undefined, motion: CSSProperties | undefined, index: number): ReactNode {
  const common = { className, style: motion };
  switch (style) {
    case "pill":
      return <rect key={index} {...common} x={cx - MASCOT_EYE_W / 2} y={cy - MASCOT_EYE_H / 2} width={MASCOT_EYE_W} height={MASCOT_EYE_H} rx={MASCOT_EYE_W / 2} fill="#fff" />;
    case "round":
      return <circle key={index} {...common} cx={cx} cy={cy + 10} r={52} fill="#fff" />;
    case "square":
      return <rect key={index} {...common} x={cx - 48} y={cy - 70} width={96} height={140} rx={22} fill="#fff" />;
    case "happy":
      return <path key={index} {...common} d={`M${cx - 50} ${cy + 26} Q ${cx} ${cy - 78} ${cx + 50} ${cy + 26}`} stroke="#fff" strokeWidth={34} {...STROKE} />;
  }
}

/**
 * A cat face (`shape: "chat"`): the openedbot mascot in the bot's colour,
 * its eyes and the small sign of its job, as on the openedbot.app tiles.
 * Alive in pure CSS like the WEBP artworks: the body breathes
 * (`bot-artwork-idle`) and each eye blinks on its own centre
 * (`mascot-eye`), with the rhythm `BotFace` derives from the seed, so two
 * cats side by side never move together.
 */
export function MascotFace({
  face,
  animated,
  rhythm,
  className,
}: {
  face: BotFaceSpec;
  animated: boolean;
  rhythm: { durationMs: number; delayMs: number };
  className?: string;
}) {
  const mascot = resolveMascot(face);
  const ink = mascotAccessoryInk(mascot.color);
  const motion: CSSProperties | undefined = animated
    ? { animationDuration: `${rhythm.durationMs}ms`, animationDelay: `${rhythm.delayMs}ms` }
    : undefined;
  return (
    <span aria-hidden data-face-kind="chat" data-face-animated={animated ? "true" : "false"} className={cn("relative inline-block shrink-0", className)}>
      <svg
        viewBox={MASCOT_VIEWBOX}
        className={cn("block size-full overflow-visible", animated && "bot-artwork-idle")}
        style={animated ? { animationDelay: `${rhythm.delayMs}ms` } : undefined}
        xmlns="http://www.w3.org/2000/svg"
      >
        {behind(mascot.accessory, ink)}
        <path d={MASCOT_BODY} fill={mascot.color} />
        {MASCOT_EYES.map((point, index) => eye(mascot.eyes, point.cx, point.cy, animated ? "mascot-eye" : undefined, motion, index))}
        {front(mascot.accessory, ink, mascot.color)}
      </svg>
    </span>
  );
}
