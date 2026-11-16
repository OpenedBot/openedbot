import { memo } from "react";
import type { Locale } from "@openedbot/browser-i18n";
import { useT } from "../../lib/i18n";
import { showsPrecip, type StripCell } from "../../lib/cards/weather-model";
import { clockLabel, hourLabel } from "../../lib/cards/weather-time";
import { weatherGlyph, WeatherIcon } from "./weather-icons";
import type { WeatherFormat } from "./weather-format";

/**
 * The hourly strip: a horizontal list that scrolls by touch, trackpad or
 * keyboard (it takes focus), its scrollbar hidden and its edges faded
 * (`.openedbot-weather-strip`, run-cards.css).
 */
export const WeatherHourlyStrip = memo(function WeatherHourlyStrip({ cells, timeZone, title, format }: {
  cells: readonly StripCell[];
  timeZone: string;
  title: string;
  format: WeatherFormat;
}) {
  const { t, locale } = useT();
  return (
    <ul
      aria-label={title}
      tabIndex={0}
      data-weather-strip=""
      className="openedbot-weather-strip no-scrollbar flex h-[6.5rem] snap-x overflow-x-auto overscroll-x-contain px-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      {cells.map((cell) => (cell.kind === "hour"
        ? <HourCell key={cell.key} cell={cell} timeZone={timeZone} locale={locale} format={format} nowLabel={t("weatherCard.now")} />
        : <SunCell key={cell.key} cell={cell} timeZone={timeZone} locale={locale} label={t(cell.kind === "sunrise" ? "weatherCard.sunrise" : "weatherCard.sunset")} />))}
    </ul>
  );
});

const CELL = "flex shrink-0 snap-start flex-col items-center justify-between py-2.5";

function HourCell({ cell, timeZone, locale, format, nowLabel }: {
  cell: Extract<StripCell, { kind: "hour" }>;
  timeZone: string;
  locale: Locale;
  format: WeatherFormat;
  nowLabel: string;
}) {
  const { t } = useT();
  const time = cell.isNow ? nowLabel : hourLabel(locale, cell.startMs, timeZone);
  const precip = showsPrecip(cell.precipChance) ? format.percent(cell.precipChance) : null;
  const temp = format.temperature(cell.temperatureC);
  const condition = format.condition(cell.conditionCode);
  return (
    <li
      data-weather-hour={cell.isNow ? "now" : ""}
      aria-label={precip
        ? t("weatherCard.hourPrecipAria", { time, condition, temp, percent: precip })
        : t("weatherCard.hourAria", { time, condition, temp })}
      className={`${CELL} ${cell.isNow ? "min-w-14 px-1.5" : "w-14"}`}
    >
      <span aria-hidden="true" className={`whitespace-nowrap text-xs leading-4 ${cell.isNow ? "font-semibold text-foreground" : "text-muted-foreground"}`}>{time}</span>
      <WeatherIcon glyph={weatherGlyph(cell.conditionCode, cell.daylight)} className="size-7" />
      <span aria-hidden="true" data-weather-precip={precip ? "" : undefined} className="h-3.5 text-[0.6875rem] font-medium leading-3.5 text-info-700">{precip}</span>
      <span aria-hidden="true" className="text-sm font-medium leading-5 tabular-nums">{temp}</span>
    </li>
  );
}

function SunCell({ cell, timeZone, locale, label }: {
  cell: Extract<StripCell, { kind: "sunrise" | "sunset" }>;
  timeZone: string;
  locale: Locale;
  label: string;
}) {
  const { t } = useT();
  const time = clockLabel(locale, cell.atMs, timeZone);
  return (
    <li data-weather-sun={cell.kind} aria-label={t("weatherCard.sunEventAria", { event: label, time })} className={`${CELL} w-[4.5rem] px-1`}>
      <span aria-hidden="true" className="whitespace-nowrap text-xs leading-4 tabular-nums text-muted-foreground">{time}</span>
      <WeatherIcon glyph={cell.kind} className="size-7" />
      <span aria-hidden="true" className="h-3.5" />
      <span aria-hidden="true" title={label} className="max-w-full truncate text-[0.6875rem] leading-5 text-muted-foreground">{label}</span>
    </li>
  );
}
