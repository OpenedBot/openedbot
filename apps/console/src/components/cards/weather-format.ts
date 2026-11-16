import { useCallback, useMemo } from "react";
import { useT } from "../../lib/i18n";
import { useTemperatureUnit } from "../../lib/cards/temperature-unit-preference";
import { displayTemperature, displayWind, precipPercent, type TemperatureUnit } from "../../lib/cards/weather-model";
import { isKnownCondition } from "./weather-icons";

export type WeatherFormat = {
  unit: TemperatureUnit;
  temperature: (celsius: number) => string;
  wind: (kph: number) => string;
  percent: (fraction: number) => string;
  condition: (code: string) => string;
};

/** The card's formatters, rebuilt only when the language or the unit changes. */
export function useWeatherFormat(): WeatherFormat {
  const { t, formatNumber } = useT();
  const unit = useTemperatureUnit();
  const temperature = useCallback(
    (celsius: number) => t("weatherCard.degrees", { value: formatNumber(displayTemperature(celsius, unit)) }),
    [t, formatNumber, unit],
  );
  return useMemo(() => ({
    unit,
    temperature,
    wind: (kph: number) => {
      const wind = displayWind(kph, unit);
      return t(wind.unit === "mph" ? "weatherCard.mph" : "weatherCard.kph", { value: formatNumber(wind.value) });
    },
    percent: (fraction: number) => t("weatherCard.percent", { value: formatNumber(precipPercent(fraction)) }),
    condition: (code: string) => (isKnownCondition(code) ? t(`weatherCard.conditions.${code}`) : t("weatherCard.unknownCondition")),
  }), [t, formatNumber, unit, temperature]);
}
