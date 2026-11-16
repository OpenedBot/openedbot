import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { RunCard } from "@openedbot/contracts-events";
import { I18nProvider } from "../../../src/lib/i18n";
import { WeatherCard } from "../../../src/components/cards/weather-card";
import { RunCardPlaceholder, RunCardView } from "../../../src/components/cards/run-card-view";
import { weatherCardHeight } from "../../../src/lib/cards/weather-model";
import { weatherCard } from "../../lib/cards/weather-fixture";

const UNIT_KEY = "openedbot:temperature-unit";

function renderCard(card = weatherCard()) {
  return render(<I18nProvider><WeatherCard card={card} /></I18nProvider>);
}

const big = (container: HTMLElement) => container.querySelector("[data-weather-temperature]")!.textContent;

beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "fr");
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("WeatherCard", () => {
  test("an article named after its place, with the current block, the strip, the days and the credit", () => {
    const { container } = renderCard();
    const article = screen.getByRole("article", { name: "Météo à Rennes" });
    expect(article.className).toContain("not-prose");
    expect(big(container)).toBe("13°");
    expect(within(article).getByText("Bruine")).toBeTruthy();
    expect(within(article).getByText("Ressenti 9° · Max. : 16° Min. : 10°")).toBeTruthy();
    expect(within(article).getByText("Vent 15 km/h · Humidité 88 %")).toBeTruthy();
    expect(within(article).getByText("Prévisions horaires")).toBeTruthy();
    expect(within(article).getByText("Prévisions quotidiennes")).toBeTruthy();
    const strip = screen.getByRole("list", { name: "Prévisions horaires" });
    expect(strip.tabIndex).toBe(0);
    const hours = within(strip).getAllByRole("listitem");
    expect(hours[0]!.textContent).toContain("Maintenant");
    expect(hours[0]!.textContent).toContain("40 %");
    // 9 % stays quiet; the sunset sits at its minute.
    expect(hours[1]!.querySelector("[data-weather-precip]")).toBeNull();
    expect(hours[1]!.textContent).toContain("14 h");
    expect(within(strip).getByRole("listitem", { name: "Coucher du soleil à 17:28" })).toBeTruthy();
    const credit = within(article).getByRole("link", { name: "Provider" });
    expect(credit.getAttribute("href")).toBe("https://weather.example.com/legal");
    expect(credit.getAttribute("target")).toBe("_blank");
    expect(credit.getAttribute("rel")).toContain("noopener");
    expect(within(article).getByText("Mis à jour 13:40")).toBeTruthy();
  });

  test("the unit toggle is a radio group: it converts at display time and persists the choice", () => {
    const { container } = renderCard();
    const group = screen.getByRole("radiogroup", { name: "Unité de température" });
    const fahrenheit = within(group).getByRole("radio", { name: "Degrés Fahrenheit" });
    expect(within(group).getByRole("radio", { name: "Degrés Celsius" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(fahrenheit);
    expect(fahrenheit.getAttribute("aria-checked")).toBe("true");
    expect(window.localStorage.getItem(UNIT_KEY)).toBe("fahrenheit");
    expect(big(container)).toBe("56°");
    expect(screen.getByText("Vent 9 mph · Humidité 88 %")).toBeTruthy();
    // Arrow keys move the choice back.
    fireEvent.keyDown(fahrenheit, { key: "ArrowRight" });
    expect(window.localStorage.getItem(UNIT_KEY)).toBe("celsius");
    expect(big(container)).toBe("13°");
  });

  test("a stored unit applies to every card from the first render", () => {
    window.localStorage.setItem(UNIT_KEY, "fahrenheit");
    const { container } = renderCard();
    expect(big(container)).toBe("56°");
  });

  test("a day row selects its day: the big block and the strip follow it", () => {
    const { container } = renderCard();
    const today = screen.getByRole("button", { name: /^Aujourd’hui/ });
    expect(today.getAttribute("aria-pressed")).toBe("true");
    const tuesday = screen.getByRole("button", { name: /^mar\. : Pluie/ });
    fireEvent.click(tuesday);
    expect(tuesday.getAttribute("aria-pressed")).toBe("true");
    expect(today.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector("[data-weather-header]")!.getAttribute("data-weather-header")).toBe("day");
    expect(big(container)).toBe("14°");
    expect(screen.getByText("Précipitations 85 %")).toBeTruthy();
    const strip = screen.getByRole("list", { name: "Prévisions horaires" });
    expect(within(strip).queryByText("Maintenant")).toBeNull();
    expect(within(strip).getAllByRole("listitem")[0]!.textContent).toContain("0 h");
    fireEvent.click(today);
    expect(big(container)).toBe("13°");
  });

  test("five days, then « Afficher plus » shows them all", () => {
    renderCard();
    const days = () => document.querySelectorAll("[data-weather-day]");
    expect(days()).toHaveLength(5);
    const more = screen.getByRole("button", { name: "Afficher plus" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(days()).toHaveLength(7);
    expect(screen.getByRole("button", { name: "Afficher moins" }).getAttribute("aria-expanded")).toBe("true");
  });

  test("range bars sit on the forecast's scale and only today's carries the « now » marker", () => {
    renderCard();
    const fill = (day: string) => document.querySelector<HTMLElement>(`[data-weather-day="${day}"] [data-weather-range-fill]`)!;
    expect(fill("2026-11-16").style.left).toBe(`${(9 / 15) * 100}%`);
    expect(fill("2026-11-16").style.right).toBe("0%");
    expect(fill("2026-11-16").style.background).toContain("linear-gradient");
    expect(document.querySelectorAll("[data-weather-now-dot]")).toHaveLength(1);
    expect(document.querySelector('[data-weather-day="2026-11-16"] [data-weather-now-dot]')).not.toBeNull();
  });

  test("a card focused on now offers the full forecast instead of the days", () => {
    renderCard(weatherCard({ display: "now" }));
    expect(document.querySelector("[data-weather-days]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Prévisions complètes" }));
    expect(document.querySelectorAll("[data-weather-day]")).toHaveLength(5);
  });

  test("an unknown condition code gets the generic glyph and label", () => {
    const card = weatherCard();
    renderCard({ ...card, weather: { ...card.weather, current: { ...card.weather.current, conditionCode: "Sandstorm" } } });
    expect(screen.getByText("Conditions non précisées")).toBeTruthy();
    expect(document.querySelector('[data-weather-header] [data-weather-glyph="unknown"]')).not.toBeNull();
  });
});

describe("RunCardView", () => {
  test("the placeholder takes the card's computed height and holds the thread's first reveal", () => {
    const card = weatherCard();
    const { container } = render(<RunCardPlaceholder card={card} />);
    const placeholder = container.querySelector<HTMLElement>("[data-run-card-placeholder='weather']")!;
    expect(placeholder.style.getPropertyValue("--wx-rest")).toBe(weatherCardHeight(card.weather));
    expect(placeholder.style.getPropertyValue("--wx-rest")).toBe("32.75rem + 4px");
    expect(placeholder.hasAttribute("data-thread-layout-pending")).toBe(true);
    // The same payload always reserves the same room, whatever the unit or the hours.
    window.localStorage.setItem("openedbot:temperature-unit", "fahrenheit");
    const again = render(<RunCardPlaceholder card={weatherCard({ hours: [] })} />).container;
    expect(again.querySelector<HTMLElement>("[data-run-card-placeholder]")!.style.getPropertyValue("--wx-rest")).toBe(placeholder.style.getPropertyValue("--wx-rest"));
  });

  test("loads the card's chunk and replaces the placeholder with the card", async () => {
    const { container } = render(<I18nProvider><RunCardView card={weatherCard()} /></I18nProvider>);
    expect(await screen.findByRole("article", { name: "Météo à Rennes" })).toBeTruthy();
    expect(container.querySelector("[data-run-card-placeholder]")).toBeNull();
  });

  test("renders nothing for a kind this console does not know", async () => {
    const unknown = { kind: "stocks", weather: weatherCard().weather } as unknown as RunCard;
    const { container } = render(<I18nProvider><RunCardView card={unknown} /></I18nProvider>);
    await act(async () => {});
    expect(container.innerHTML).toBe("");
  });
});
