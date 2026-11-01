import { useId } from "react";

/** The iridescent band's colours (pulseview `composer-loader.tsx`). */
const STOPS = ["#5eead4", "#46baec", "#e633a4", "#00faa7"] as const;

/**
 * A band of light that runs around the composer card while a run works, as
 * the `ComposerLoader` of streaming-ui.pulseview.app: two dash segments on
 * a rounded `rect` (`pathLength=100`, so the speed is constant and the band
 * follows the corners), a crisp line over a soft glow, one lap in 4.5 s,
 * fading in and out in 450 ms. It sits on the object the operator is looking
 * at, where the stop button is.
 *
 * The glow is a native SVG `feGaussianBlur`, never a CSS `filter`: WebKit
 * (every iPhone) ignores CSS filters on SVG elements. The overlay is
 * `absolute` inside the card, never `fixed` (PWA contract), takes no pointer
 * event and no space. Hidden, it is `visibility: hidden`, so the browser
 * paints nothing; under `prefers-reduced-motion` it is not drawn at all
 * (`agent-activity.css`).
 */
export function ComposerLoader({ active }: { active: boolean }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const gradient = `${id}-composer-band`;
  const blur = `${id}-composer-glow`;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      data-composer-loader=""
      data-active={active ? "" : undefined}
      className="ohb-composer-loader"
    >
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          {STOPS.map((color, index) => (
            <stop key={color} offset={`${(index / (STOPS.length - 1)) * 100}%`} stopColor={color} />
          ))}
        </linearGradient>
        <filter id={blur} x="-10%" y="-60%" width="120%" height="220%">
          <feGaussianBlur stdDeviation="5" />
        </filter>
      </defs>
      <rect
        className="ohb-composer-loader-band"
        width="100%"
        height="100%"
        rx="22"
        pathLength={100}
        fill="none"
        stroke={`url(#${gradient})`}
        strokeWidth="5"
        filter={`url(#${blur})`}
      />
      <rect
        className="ohb-composer-loader-band"
        width="100%"
        height="100%"
        rx="22"
        pathLength={100}
        fill="none"
        stroke={`url(#${gradient})`}
        strokeWidth="1.5"
      />
    </svg>
  );
}
