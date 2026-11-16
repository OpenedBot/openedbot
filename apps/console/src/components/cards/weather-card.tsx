import { memo, useCallback, useMemo, useState, type KeyboardEvent } from "react";
import type { WeatherRunCard } from "@openedbot/contracts-events";
import { useT } from "../../lib/i18n";
import { setTemperatureUnit } from "../../lib/cards/temperature-unit-preference";
import { forecastToday, hourlyCells, initialDay, weatherHeader, type TemperatureUnit, type WeatherHeader } from "../../lib/cards/weather-model";
import { clockLabel } from "../../lib/cards/weather-time";
import { WeatherDailyList } from "./weather-card-days";
import { WeatherHourlyStrip } from "./weather-card-strip";
import { useWeatherFormat, type WeatherFormat } from "./weather-format";
import { weatherGlyph, WeatherIcon } from "./weather-icons";

/**
 * The weather card of a tool result. Section heights are fixed in `rem`
 * (`weatherCardHeight` mirrors them for the loading placeholder). Selecting a
 * day re-centers the big block and the hourly strip on it; the °C / °F choice
 * is global and only re-renders the cards.
 */
export const WeatherCard = memo(function WeatherCard({ card }: { card: WeatherRunCard }) {
  const { weather } = card;
  const { t, locale } = useT();
  const format = useWeatherFormat();
  const todayKey = useMemo(() => forecastToday(weather), [weather]);
  const [selectedDay, setSelectedDay] = useState(() => initialDay(weather, todayKey));
  const [showWeek, setShowWeek] = useState((weather.display ?? "week") === "week");
  const header = useMemo(() => weatherHeader(weather, selectedDay, todayKey), [weather, selectedDay, todayKey]);
  const cells = useMemo(
    () => hourlyCells(weather, selectedDay === todayKey ? null : selectedDay),
    [weather, selectedDay, todayKey],
  );
  const selectDay = useCallback((dayKey: string) => setSelectedDay(dayKey), []);
  const divider = "border-t border-border/60";
  return (
    <article
      aria-label={t("weatherCard.cardLabel", { location: weather.locationLabel })}
      data-run-card="weather"
      className="openedbot-weather-card not-prose w-full min-w-0 overflow-hidden rounded-[1.375rem] border border-border/60 bg-surface text-foreground"
    >
      <header className="flex h-12 items-center justify-between gap-3 pl-5 pr-3">
        <h3 className="min-w-0 truncate text-[0.9375rem] font-semibold">{weather.locationLabel}</h3>
        <UnitToggle unit={format.unit} />
      </header>
      <HeaderBlock header={header} format={format} />
      <section className={divider}>
        <h4 className="flex h-9 items-end px-5 pb-1 text-xs font-medium text-muted-foreground">{t("weatherCard.hourlyTitle")}</h4>
        <WeatherHourlyStrip cells={cells} timeZone={weather.timeZone} title={t("weatherCard.hourlyTitle")} format={format} />
      </section>
      {showWeek ? (
        <section className={divider}>
          <h4 className="flex h-9 items-end px-5 pb-1 text-xs font-medium text-muted-foreground">{t("weatherCard.dailyTitle")}</h4>
          <WeatherDailyList
            days={weather.days}
            todayKey={todayKey}
            selectedDay={selectedDay}
            nowC={weather.current.temperatureC}
            format={format}
            onSelect={selectDay}
          />
        </section>
      ) : (
        <button
          type="button"
          onClick={() => setShowWeek(true)}
          className={`${divider} flex h-11 w-full items-center justify-center text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`}
        >
          {t("weatherCard.fullForecast")}
        </button>
      )}
      <footer className={`${divider} flex h-10 items-center justify-between gap-3 px-5 text-[0.6875rem] text-muted-foreground`}>
        <a
          href={weather.attribution.url}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 truncate rounded-sm underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {weather.attribution.label}
        </a>
        <span className="shrink-0 tabular-nums">{t("weatherCard.updatedAt", { time: clockLabel(locale, weather.asOfMs, weather.timeZone) })}</span>
      </footer>
    </article>
  );
});

const UNITS: readonly { unit: TemperatureUnit; symbol: "weatherCard.fahrenheit" | "weatherCard.celsius"; name: "weatherCard.fahrenheitName" | "weatherCard.celsiusName" }[] = [
  { unit: "fahrenheit", symbol: "weatherCard.fahrenheit", name: "weatherCard.fahrenheitName" },
  { unit: "celsius", symbol: "weatherCard.celsius", name: "weatherCard.celsiusName" },
];

/** A two-option radio group: arrows move the choice, as a native radio group does. */
function UnitToggle({ unit }: { unit: TemperatureUnit }) {
  const { t } = useT();
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const other = unit === "celsius" ? "fahrenheit" : "celsius";
    setTemperatureUnit(other);
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-unit="${other}"]`)?.focus();
  };
  return (
    <div role="radiogroup" aria-label={t("weatherCard.unitGroup")} className="relative flex h-7 shrink-0 items-center rounded-full bg-foreground/[0.06] p-0.5 dark:bg-foreground/[0.08]">
      <span
        aria-hidden="true"
        className="absolute left-0.5 top-0.5 h-6 w-9 rounded-full bg-background shadow-sm transition-transform dark:bg-foreground/[0.2] dark:shadow-none duration-200 motion-reduce:transition-none"
        style={{ transform: unit === "celsius" ? "translateX(100%)" : undefined }}
      />
      {UNITS.map((option) => (
        <button
          key={option.unit}
          type="button"
          role="radio"
          aria-checked={unit === option.unit}
          aria-label={t(option.name)}
          tabIndex={unit === option.unit ? 0 : -1}
          data-unit={option.unit}
          onClick={() => setTemperatureUnit(option.unit)}
          onKeyDown={onKeyDown}
          className={`relative h-6 w-9 rounded-full text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none ${unit === option.unit ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          {t(option.symbol)}
        </button>
      ))}
    </div>
  );
}

function HeaderBlock({ header, format }: { header: WeatherHeader; format: WeatherFormat }) {
  const { t } = useT();
  const range = [
    header.maxC !== null ? t("weatherCard.high", { temp: format.temperature(header.maxC) }) : null,
    header.minC !== null ? t("weatherCard.low", { temp: format.temperature(header.minC) }) : null,
  ].filter(Boolean).join(" ");
  const lines = header.kind === "current"
    ? [
        [t("weatherCard.feelsLike", { temp: format.temperature(header.apparentC) }), range].filter(Boolean).join(" · "),
        [t("weatherCard.wind", { speed: format.wind(header.windKph) }), t("weatherCard.humidity", { percent: format.percent(header.humidity) })].join(" · "),
      ]
    : [range, t("weatherCard.precipitation", { percent: format.percent(header.precipChance) })];
  return (
    <div data-weather-header={header.kind} className="openedbot-weather-block flex items-center gap-5 px-5 pb-3">
      <div className="flex items-center gap-3">
        <WeatherIcon glyph={weatherGlyph(header.conditionCode, header.daylight)} className="size-14 shrink-0" />
        <span data-weather-temperature="" className="text-[3.25rem] font-light leading-none tracking-tight tabular-nums">
          {format.temperature(header.temperatureC)}
        </span>
      </div>
      <div className="openedbot-weather-text min-w-0 flex-1">
        <p className="truncate text-[0.9375rem] font-medium leading-6">{format.condition(header.conditionCode)}</p>
        {lines.map((line) => <p key={line} className="truncate text-[0.8125rem] leading-5 text-muted-foreground">{line}</p>)}
      </div>
    </div>
  );
}
