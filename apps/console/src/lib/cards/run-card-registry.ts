import type { ComponentType } from "react";
import type { RunCard, RunCardKind } from "@openedbot/contracts-events";
import { weatherCardHeight } from "./weather-model";

/**
 * The card kinds the console can render. Each kind is its own lazy chunk
 * (like Mermaid): a thread without a card downloads none of them. The
 * placeholder height is computed from the payload so swapping the
 * placeholder for the loaded card does not move the thread.
 */
export type RunCardOf<K extends RunCardKind> = Extract<RunCard, { kind: K }>;

export type RunCardRegistration<K extends RunCardKind> = {
  load: () => Promise<{ default: ComponentType<{ card: RunCardOf<K> }> }>;
  /** Terms of a `calc()` (`rem + px`); the placeholder adds the kind's variable block height. */
  placeholderHeight: (card: RunCardOf<K>) => string;
};

export const RUN_CARD_REGISTRY: { [K in RunCardKind]: RunCardRegistration<K> } = {
  weather: {
    load: () => import("../../components/cards/weather-card").then((module) => ({ default: module.WeatherCard })),
    placeholderHeight: (card) => weatherCardHeight(card.weather),
  },
};

/** The registration of a kind, `null` for a kind this console does not know (a newer runtime). */
export function runCardRegistration(kind: string): RunCardRegistration<RunCardKind> | null {
  return Object.hasOwn(RUN_CARD_REGISTRY, kind) ? RUN_CARD_REGISTRY[kind as RunCardKind] : null;
}
