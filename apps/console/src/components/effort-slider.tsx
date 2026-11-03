import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  HERMES_REASONING_EFFORT_LABELS,
  HERMES_REASONING_EFFORTS,
  type HermesReasoningEffort,
} from "@openedbot/contracts-api";
import { cn } from "@openedbot/browser-ui-kit";
import { useT } from "../lib/i18n";
import { EffortFlame } from "./effort-flame";

function subscribeReducedMotion(onChange: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function reducedMotionSnapshot() {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

/**
 * Le curseur ne propose que les valeurs réellement comprises par Hermes. Les
 * six crans sont donc des options, pas une approximation numérique de
 * `reasoning_effort`.
 */
export function EffortSlider({
  value,
  explicit,
  disabled,
  look = "sheet",
  onChange,
  onCommit,
}: {
  value: HermesReasoningEffort;
  /** `false` signifie que le runtime décide encore de la valeur effective. */
  explicit: boolean;
  disabled: boolean;
  /**
   * `popover` : le panneau du bureau, au plus près du template (crans éteints
   * après la valeur, anneau de focus sur le curseur, curseur sans glissement).
   * `sheet` : la feuille mobile, inchangée.
   */
  look?: "popover" | "sheet";
  onChange: (effort: HermesReasoningEffort) => void;
  onCommit: (effort: HermesReasoningEffort) => void;
}) {
  const { t } = useT();
  const reducedMotion = useSyncExternalStore(subscribeReducedMotion, reducedMotionSnapshot, () => false);
  const index = HERMES_REASONING_EFFORTS.indexOf(value);
  const max = HERMES_REASONING_EFFORTS.length - 1;
  const ratio = index / max;
  const isMax = !reducedMotion && index === max;
  const label = explicit
    ? HERMES_REASONING_EFFORT_LABELS[value]
    : t("composer.modelEffortDefault");

  /** Les crans quittent la piste à l'allumage, avec une trajectoire neuve. */
  const scatter = useMemo(
    () => HERMES_REASONING_EFFORTS.map(() => ({
      x: -(70 + 130 * Math.random()),
      y: (Math.random() - 0.5) * 70,
      rotate: (Math.random() - 0.5) * 720,
      delay: 0.3 * Math.random(),
    })),
    [isMax],
  );
  const [burning, setBurning] = useState(isMax);

  useEffect(() => {
    if (isMax) {
      setBurning(true);
      return;
    }
    const timer = window.setTimeout(() => setBurning(false), 300);
    return () => window.clearTimeout(timer);
  }, [isMax]);

  const effortAt = (raw: string) => HERMES_REASONING_EFFORTS[Number(raw)];
  const interactionEffort = useRef(value);
  // Un clic sur la piste peut donner le focus APRÈS avoir déplacé la valeur :
  // pendant un appui, le point de départ est celui du pointerdown.
  const pointerActive = useRef(false);
  const commitEffort = (effort: HermesReasoningEffort | undefined) => {
    if (effort && effort !== interactionEffort.current) {
      onCommit(effort);
      interactionEffort.current = effort;
    }
  };
  const popoverLook = look === "popover";
  // Le template n'anime le nom du cran qu'au changement de valeur, pas à l'ouverture du panneau.
  const [openedLabel] = useState(label);

  return (
    // Le réglage d'effort de BoardUI (boardui.com/components/composer-attachments),
    // en jetons de thème seulement : une couleur littérale tient dans un thème
    // et casse l'autre. Piste secondary, remplissage tertiary-hover, crans
    // icon-tertiary, curseur sur fond primary avec la bordure des boutons.
    <div className={cn("flex w-full flex-col pt-1", disabled && "opacity-50")}>
      <p className="-mb-0.5 ps-2 text-body-medium text-text-secondary">
        {t("composer.modelEffort")} {" "}
        <span key={label} className={cn("inline-block text-text-primary", (!popoverLook || label !== openedLabel) && "animate-effort-label")}>
          {label}
        </span>
      </p>
      <div className={cn("flex flex-col", popoverLook && "gap-1")}>
      <div className="flex items-center justify-between px-2 pt-2 pb-[3px] text-body-2-medium text-text-secondary">
        <span>{t("composer.modelFaster")}</span>
        <span>{t("composer.modelSmarter")}</span>
      </div>
      <div className="px-2 pb-2">
        <div className={cn("relative h-[27px] w-full overflow-hidden bg-background-secondary-default", popoverLook ? "rounded-[8px]" : "rounded-lg")}>
          <div
            aria-hidden
            className={cn("absolute inset-y-0 start-0 bg-background-tertiary-hover transition-[width] duration-150 ease-out", popoverLook ? "rounded-[8px]" : "rounded-lg")}
            style={{ width: `calc(${ratio} * (100% - 21px) + 21px)` }}
          />
          <div aria-hidden className="absolute inset-x-[9px] top-[7px] flex h-[13px] items-center justify-between">
            {HERMES_REASONING_EFFORTS.map((effort, effortIndex) => (
              <span
                key={effort}
                className="h-full w-[3px] rounded-[2px] bg-foreground-icon-tertiary"
                style={isMax
                  ? {
                      transform: `translate(${scatter[effortIndex]!.x}px, ${scatter[effortIndex]!.y}px) rotate(${scatter[effortIndex]!.rotate}deg)`,
                      opacity: 0,
                      transition: `transform 1.6s cubic-bezier(0.22,0.5,0.5,1) ${scatter[effortIndex]!.delay}s, opacity 1.6s cubic-bezier(0.22,0.5,0.5,1) ${scatter[effortIndex]!.delay}s`,
                    }
                  : {
                      transform: "none",
                      // Panneau du bureau : les crans après la valeur s'éteignent
                      // (0,3), sans fondu, comme le template.
                      opacity: popoverLook && effortIndex > index ? 0.3 : 1,
                      transition: popoverLook && !burning
                        ? "transform 300ms ease-out"
                        : "transform 300ms ease-out, opacity 300ms ease-out",
                    }}
              />
            ))}
          </div>
          {burning ? (
            <div
              aria-hidden
              className={cn(
                "pointer-events-none absolute inset-0 duration-300 ease-out",
                isMax ? "animate-in fade-in" : "animate-out fade-out fill-mode-forwards",
              )}
            >
              <EffortFlame />
            </div>
          ) : null}
          <div className="absolute inset-x-[10.5px] inset-y-0">
            <input
              data-composer-effort-slider=""
              type="range"
              min={0}
              max={max}
              step={1}
              value={index}
              disabled={disabled}
              aria-label={t("composer.modelEffort")}
              aria-valuetext={label}
              onChange={(event) => {
                const effort = effortAt(event.target.value);
                if (effort) onChange(effort);
              }}
              onFocus={(event) => {
                if (!pointerActive.current) interactionEffort.current = effortAt(event.currentTarget.value) ?? value;
              }}
              onPointerDown={(event) => {
                pointerActive.current = true;
                interactionEffort.current = effortAt(event.currentTarget.value) ?? value;
              }}
              onPointerUp={(event) => {
                pointerActive.current = false;
                commitEffort(effortAt(event.currentTarget.value));
              }}
              onPointerCancel={() => { pointerActive.current = false; }}
              onKeyUp={(event) => {
                commitEffort(effortAt(event.currentTarget.value));
              }}
              onBlur={(event) => {
                commitEffort(effortAt(event.currentTarget.value));
              }}
              className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
            />
            <div
              aria-hidden
              className={cn(
                "pointer-events-none absolute top-1/2 h-[27px] w-[21px] -translate-x-1/2 -translate-y-1/2 rounded-[7px] border border-border-button-default bg-background-primary-default shadow-xs",
                popoverLook
                  ? "transition-shadow duration-150 peer-focus-visible:ring-2 peer-focus-visible:ring-border-focus-ring"
                  : "transition-[left] duration-150 ease-out",
              )}
              style={{ left: `${ratio * 100}%` }}
            />
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
