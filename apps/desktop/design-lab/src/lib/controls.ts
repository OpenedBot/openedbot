import { useSearchParams } from "react-router";
import { SIZES, STATES, type Locale, type PreviewState, type Theme } from "./preview";

/*
  The preview controls live in the URL (?theme=&locale=&state=&size=), so a
  view of the lab is a link: share it, reload it, compare it.
*/
export type ThemeChoice = Theme | "both";

export type Controls = {
  theme: ThemeChoice;
  locale: Locale;
  state: PreviewState;
  size: (typeof SIZES)[number];
};

export function useControls(): [Controls, (patch: Partial<Record<"theme" | "locale" | "state" | "size", string>>) => void] {
  const [params, setParams] = useSearchParams();
  const theme = params.get("theme");
  const state = params.get("state");
  const controls: Controls = {
    theme: theme === "light" || theme === "both" ? theme : "dark",
    locale: params.get("locale") === "en" ? "en" : "fr",
    state: STATES.some((entry) => entry.id === state) ? (state as PreviewState) : "idle",
    size: SIZES.find((entry) => entry.id === params.get("size")) ?? SIZES[0]!,
  };
  const update = (patch: Partial<Record<"theme" | "locale" | "state" | "size", string>>): void => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        next.set(key, value);
      }
      return next;
    }, { replace: true });
  };
  return [controls, update];
}

export function themesOf(choice: ThemeChoice): Theme[] {
  return choice === "both" ? ["dark", "light"] : [choice];
}
