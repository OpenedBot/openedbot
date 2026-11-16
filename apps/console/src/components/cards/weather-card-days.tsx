import { memo, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { WeatherDay } from "@openedbot/contracts-events";
import { useT } from "../../lib/i18n";
import {
  COLLAPSED_DAYS,
  forecastBounds,
  gradientSlice,
  rangeFractions,
  scaleFraction,
  showsPrecip,
  type TemperatureBounds,
} from "../../lib/cards/weather-model";
import { weekdayLabel } from "../../lib/cards/weather-time";
import { weatherGlyph, WeatherIcon } from "./weather-icons";
import type { WeatherFormat } from "./weather-format";

/**
 * The daily rows: every bar on the forecast's one scale, each filled with its
 * slice of the absolute temperature gradient. A row is a toggle button that
 * focuses the card on its day; five rows, then « Afficher plus ».
 */
export const WeatherDailyList = memo(function WeatherDailyList({ days, todayKey, selectedDay, nowC, format, onSelect }: {
  days: readonly WeatherDay[];
  todayKey: string;
  selectedDay: string;
  /** The current temperature, marked on today's bar. */
  nowC: number;
  format: WeatherFormat;
  onSelect: (dayKey: string) => void;
}) {
  const { t, locale } = useT();
  const [expanded, setExpanded] = useState(false);
  const bounds = useMemo(() => forecastBounds(days), [days]);
  const shown = expanded ? days : days.slice(0, COLLAPSED_DAYS);
  return (
    <>
      <ul className="px-2 pb-1" data-weather-days="">
        {shown.map((day) => {
          const label = day.dateDay === todayKey ? t("weatherCard.today") : weekdayLabel(locale, day.dateDay);
          return (
            <li key={day.dateDay}>
              <DayRow
                day={day}
                label={label}
                bounds={bounds}
                selected={day.dateDay === selectedDay}
                nowC={day.dateDay === todayKey ? nowC : null}
                format={format}
                onSelect={onSelect}
              />
            </li>
          );
        })}
      </ul>
      {days.length > COLLAPSED_DAYS ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          className="flex h-9 w-full items-center justify-center gap-1 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {t(expanded ? "weatherCard.showLess" : "weatherCard.showMore")}
          <ChevronDown aria-hidden className={`size-3.5 transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`} />
        </button>
      ) : null}
    </>
  );
});

function DayRow({ day, label, bounds, selected, nowC, format, onSelect }: {
  day: WeatherDay;
  label: string;
  bounds: TemperatureBounds;
  selected: boolean;
  nowC: number | null;
  format: WeatherFormat;
  onSelect: (dayKey: string) => void;
}) {
  const { t } = useT();
  const { start, end } = rangeFractions(day.minC, day.maxC, bounds);
  const precip = showsPrecip(day.precipChance) ? format.percent(day.precipChance) : null;
  const low = format.temperature(day.minC);
  const high = format.temperature(day.maxC);
  const condition = format.condition(day.conditionCode);
  const aria = precip
    ? t("weatherCard.dayPrecipAria", { day: label, condition, low, high, percent: precip })
    : t("weatherCard.dayAria", { day: label, condition, low, high });
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={aria}
      data-weather-day={day.dateDay}
      onClick={() => onSelect(day.dateDay)}
      className="grid h-11 w-full grid-cols-[minmax(3.25rem,min(6rem,26%))_1.75rem_2.5rem_minmax(2.5rem,1fr)_2.5rem] items-center gap-x-2.5 rounded-xl px-3 text-left text-sm outline-none transition-colors hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-foreground/[0.07] motion-reduce:transition-none"
    >
      <span aria-hidden="true" className="truncate font-medium">{label}</span>
      <span aria-hidden="true" className="flex flex-col items-center">
        <WeatherIcon glyph={weatherGlyph(day.conditionCode, true)} className="size-5" />
        {precip ? <span data-weather-precip="" className="text-[0.625rem] font-medium leading-3 text-info-700">{precip}</span> : null}
      </span>
      <span aria-hidden="true" className="text-right tabular-nums text-muted-foreground">{low}</span>
      <span aria-hidden="true" data-weather-range="" className="relative h-1.5 rounded-full bg-foreground/10">
        <span
          data-weather-range-fill=""
          className="absolute inset-y-0 min-w-1.5 rounded-full"
          style={{ left: `${start * 100}%`, right: `${(1 - end) * 100}%`, background: gradientSlice(day.minC, day.maxC) }}
        />
        {nowC !== null ? (
          <span
            data-weather-now-dot=""
            className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_0_1.5px_var(--color-surface)]"
            style={{ left: `${scaleFraction(Math.min(Math.max(nowC, day.minC), day.maxC), bounds) * 100}%` }}
          />
        ) : null}
      </span>
      <span aria-hidden="true" className="text-right font-medium tabular-nums">{high}</span>
    </button>
  );
}
