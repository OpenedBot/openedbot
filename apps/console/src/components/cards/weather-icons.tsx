import { memo, type ReactNode } from "react";
import { WEATHER_CONDITION_CODES, type WeatherConditionCode } from "@openedbot/contracts-events";

/**
 * The weather card's own glyphs, drawn on a 32 px grid: flat fills for the
 * bodies (sun, moon, clouds), round 2 px strokes for what falls or blows.
 * Colors come from `--wx-*` (run-cards.css), themed for light and dark, so
 * one drawing reads from 16 to 56 px on either surface.
 */
export type WeatherGlyph =
  | "sun" | "moon" | "cloudSun" | "cloudMoon" | "cloud" | "fog" | "drizzle" | "rain" | "heavyRain"
  | "thunder" | "snow" | "sleet" | "wind" | "hot" | "cold" | "sunrise" | "sunset" | "unknown";

type Family = "clear" | "partly" | "cloud" | "fog" | "wind" | "drizzle" | "rain" | "heavyRain" | "thunder" | "snow" | "sleet" | "hot" | "cold";

/** Every known condition code to its family; the day/night variant is chosen in `weatherGlyph`. */
const FAMILY: Record<WeatherConditionCode, Family> = {
  Clear: "clear", MostlyClear: "clear",
  PartlyCloudy: "partly", MostlyCloudy: "cloud", Cloudy: "cloud",
  Foggy: "fog", Haze: "fog", Smoky: "fog", BlowingDust: "fog",
  Breezy: "wind", Windy: "wind", Tornado: "wind",
  Drizzle: "drizzle", FreezingDrizzle: "drizzle",
  Rain: "rain", SunShowers: "rain", FreezingRain: "rain", HeavyRain: "heavyRain",
  IsolatedThunderstorms: "thunder", ScatteredThunderstorms: "thunder", StrongStorms: "thunder",
  Thunderstorms: "thunder", Hurricane: "thunder", TropicalStorm: "thunder",
  Flurries: "snow", Snow: "snow", HeavySnow: "snow", SunFlurries: "snow", Blizzard: "snow", BlowingSnow: "snow",
  Sleet: "sleet", Hail: "sleet", WintryMix: "sleet",
  MixedRainAndSleet: "sleet", MixedRainAndSnow: "sleet", MixedSnowAndSleet: "sleet",
  Hot: "hot", Frigid: "cold",
};

const KNOWN = new Set<string>(WEATHER_CONDITION_CODES);

export function isKnownCondition(code: string): code is WeatherConditionCode {
  return KNOWN.has(code);
}

/** The glyph of a condition: clear and partly cloudy skies follow day and night; an unknown code gets the generic one. */
export function weatherGlyph(code: string, daylight: boolean): WeatherGlyph {
  if (!isKnownCondition(code)) return "unknown";
  const family = FAMILY[code];
  if (family === "clear") return daylight ? "sun" : "moon";
  if (family === "partly") return daylight ? "cloudSun" : "cloudMoon";
  return family;
}

const CLOUD = "M9 25h14.5a5.5 5.5 0 0 0 .9-10.93A7.5 7.5 0 0 0 10.1 15.6 4.75 4.75 0 0 0 9 25Z";
const MOON = "M13.72 7.08A10 10 0 1 0 24.92 18.28 8.5 8.5 0 0 1 13.72 7.08Z";
const stroke = { fill: "none", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function Rays({ cx, cy, inner, outer }: { cx: number; cy: number; inner: number; outer: number }) {
  return (
    <g stroke="var(--wx-sun)" {...stroke}>
      {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => {
        const r = (angle * Math.PI) / 180;
        const [sx, sy] = [Math.cos(r), Math.sin(r)];
        return <line key={angle} x1={cx + sx * inner} y1={cy + sy * inner} x2={cx + sx * outer} y2={cy + sy * outer} />;
      })}
    </g>
  );
}

/** A cloud raised by 5 px, room underneath for what falls from it. */
const raisedCloud = <path d={CLOUD} transform="translate(0 -5)" fill="var(--wx-cloud)" />;

function falling(kind: "drop" | "dot" | "flake", x: number, y: number): ReactNode {
  if (kind === "dot") return <circle key={`${x}`} cx={x} cy={y + 1.5} r={1.25} fill="var(--wx-rain)" />;
  if (kind === "flake") {
    return (
      <g key={`${x}`} stroke="var(--wx-snow)" {...stroke} strokeWidth={1.6}>
        <line x1={x} y1={y - 0.5} x2={x} y2={y + 4.5} />
        <line x1={x - 2.2} y1={y + 0.75} x2={x + 2.2} y2={y + 3.25} />
        <line x1={x - 2.2} y1={y + 3.25} x2={x + 2.2} y2={y + 0.75} />
      </g>
    );
  }
  return <line key={`${x}`} x1={x + 0.8} y1={y} x2={x - 0.8} y2={y + 4.5} stroke="var(--wx-rain)" {...stroke} />;
}

function horizon(rising: boolean): ReactNode {
  return (
    <>
      <path d="M9.5 23a6.5 6.5 0 0 1 13 0Z" fill="var(--wx-sun)" />
      <g stroke="var(--wx-sun)" {...stroke}>
        <line x1="5" y1="17.5" x2="7" y2="18.6" />
        <line x1="27" y1="17.5" x2="25" y2="18.6" />
        <line x1="9.2" y1="12.6" x2="10.5" y2="14.3" />
        <line x1="22.8" y1="12.6" x2="21.5" y2="14.3" />
      </g>
      <line x1="4" y1="26" x2="28" y2="26" stroke="var(--wx-cloud)" {...stroke} />
      <path d={rising ? "M13 7.5 16 4.5l3 3M16 4.5v6" : "M13 7.5 16 10.5l3-3M16 10.5v-6"} stroke="var(--wx-sun)" {...stroke} />
    </>
  );
}

const DRAWINGS: Record<WeatherGlyph, () => ReactNode> = {
  sun: () => (
    <>
      <Rays cx={16} cy={16} inner={9.5} outer={13} />
      <circle cx="16" cy="16" r="6.25" fill="var(--wx-sun)" />
    </>
  ),
  moon: () => <path d={MOON} fill="var(--wx-moon)" />,
  cloudSun: () => (
    <>
      <Rays cx={12} cy={11.5} inner={6.6} outer={8.8} />
      <circle cx="12" cy="11.5" r="4.6" fill="var(--wx-sun)" />
      <path d={CLOUD} transform="translate(2.5 1.5)" fill="var(--wx-cloud)" />
    </>
  ),
  cloudMoon: () => (
    <>
      <path d={MOON} transform="translate(-1 -2) scale(.7)" fill="var(--wx-moon)" />
      <path d={CLOUD} transform="translate(2.5 1.5)" fill="var(--wx-cloud)" />
    </>
  ),
  cloud: () => <path d={CLOUD} transform="translate(0 -1)" fill="var(--wx-cloud)" />,
  fog: () => (
    <>
      {raisedCloud}
      <g stroke="var(--wx-cloud)" {...stroke}>
        <line x1="7" y1="24" x2="25" y2="24" />
        <line x1="10" y1="28" x2="22" y2="28" />
      </g>
    </>
  ),
  drizzle: () => <>{raisedCloud}{[11, 16, 21].map((x) => falling("dot", x, 23))}</>,
  rain: () => <>{raisedCloud}{[11, 16, 21].map((x) => falling("drop", x, 23))}</>,
  heavyRain: () => <>{raisedCloud}{[9, 13.7, 18.3, 23].map((x) => falling("drop", x, 22.5))}{[11.3, 20.6].map((x) => falling("drop", x, 27))}</>,
  thunder: () => (
    <>
      {raisedCloud}
      <path d="M17 20.5 13 26.5h3.4l-1.4 5 5-7h-3.5l1.8-4Z" fill="var(--wx-sun)" />
    </>
  ),
  snow: () => <>{raisedCloud}{[10.5, 16, 21.5].map((x) => falling("flake", x, 23))}</>,
  sleet: () => <>{raisedCloud}{falling("drop", 11, 23)}{falling("flake", 16, 23)}{falling("drop", 21, 23)}</>,
  wind: () => (
    <g stroke="var(--wx-cloud)" {...stroke}>
      <path d="M4 12.5h14.5a3.5 3.5 0 1 0-3.5-3.5" />
      <path d="M4 18h19.5a3.5 3.5 0 1 1-3.5 3.5" />
      <path d="M4 23.5h9" />
    </g>
  ),
  hot: () => (
    <>
      <Rays cx={16} cy={16} inner={9.5} outer={13} />
      <circle cx="16" cy="16" r="6.25" fill="var(--wx-hot)" />
    </>
  ),
  cold: () => (
    <g stroke="var(--wx-snow)" {...stroke}>
      <path d="M16 4v24M5.6 10l20.8 12M5.6 22l20.8-12" />
      <path d="m13 6 3 2.5L19 6M13 26l3-2.5 3 2.5" />
    </g>
  ),
  sunrise: () => horizon(true),
  sunset: () => horizon(false),
  unknown: () => (
    <g stroke="var(--wx-cloud)" {...stroke}>
      <path d="M13.5 18.2V7.5a2.5 2.5 0 0 1 5 0v10.7a5 5 0 1 1-5 0Z" />
      <circle cx="16" cy="22.2" r="1.6" fill="var(--wx-cloud)" />
    </g>
  ),
};

/** A glyph, decorative: the text next to it always names the condition. */
export const WeatherIcon = memo(function WeatherIcon({ glyph, className }: { glyph: WeatherGlyph; className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" data-weather-glyph={glyph} className={className}>
      {DRAWINGS[glyph]()}
    </svg>
  );
});
