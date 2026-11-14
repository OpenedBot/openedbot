import type { ReactNode } from "react";
import { ArrowLeft, Check } from "lucide-react";
import { ONBOARDING_STEP_ORDER, railIndex, type OnboardingStep, type RailStep } from "@/lib/session/onboarding";
import { cn } from "@openedbot/browser-ui-kit";
import {
  DotSphere,
  ObButton,
  Stepper,
  StepperDescription,
  StepperIndicator,
  StepperItem,
  StepperNav,
  StepperSeparator,
  StepperTitle,
} from "@openedbot/browser-ui-kit/components/onboarding";
import { useT } from "../../../lib/i18n";
import { Wordmark } from "./wordmark";

/**
 * The persistent rail: where the operator stands, and which way to go back.
 *
 * Three things are worth knowing:
 *
 *   - **`dark` set on the panel, not inverted utilities.** `.dark`
 *     is a plain class selector in our token sheet:
 *     writing it here redefines the custom properties FOR THIS
 *     subtree. `text-muted-foreground` then means the right thing on
 *     a dark surface. Mixing `text-background/60` by hand is what
 *     made the « Se déconnecter » button nearly invisible at Multica.
 *   - **This is not a `tablist`.** The carried stepper is `role="tablist"`
 *     by default, each trigger owning an `aria-controls` on a
 *     panel: right for a stepper that renders its own panels, false
 *     here, where the panel is a routed step and those identifiers
 *     would dangle. The presentational slots are used and the
 *     position is marked with `aria-current="step"`.
 *   - **Only the steps already passed are clickable.** Moving forward requires playing
 *     the validation and the send of the current step: jumping ahead from the
 *     rail would bypass them. Going back is always safe.
 */

/**
 * The rail's job (where am I, and which way back) at widths too
 * narrow for the rail itself. Rendered only below `md`, where
 * `StepSidebar` is hidden.
 *
 * Segments rather than a replay of the list: at 375 px, the point is to
 * spend as little height as possible, and the current step's name plus its
 * position is what the list communicated anyway. It reuses the
 * same `step_nav` copy, so there is only one place to translate.
 */
export function StepProgressBar({
  currentStep,
  onBack,
  backDisabled,
  footer,
}: {
  currentStep: OnboardingStep;
  onBack?: () => void;
  backDisabled?: boolean;
  /** The same slot as the rail's foot: the « Se déconnecter » exit.
   *  It MUST be repeated here: the rail is hidden at these widths, which
   *  left every step other than the welcome with no way out. */
  footer?: ReactNode;
}) {
  const { t } = useT();
  const currentIndex = railIndex(currentStep);
  const key = ONBOARDING_STEP_ORDER[currentIndex] ?? ONBOARDING_STEP_ORDER[0]!;

  return (
    <div className="mb-6 flex items-center gap-3 md:hidden">
      {onBack ? (
        <ObButton
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          disabled={backDisabled}
          aria-label={t("onboarding.common.back")}
          className="-ml-2 shrink-0"
        >
          <ArrowLeft />
        </ObButton>
      ) : null}
      <span aria-hidden className="flex flex-1 items-center gap-1.5">
        {ONBOARDING_STEP_ORDER.map((stepId, index) => (
          <span
            key={stepId}
            className={cn(
              "h-1 flex-1 rounded-full transition-colors",
              index <= currentIndex ? "bg-foreground" : "bg-border",
            )}
          />
        ))}
      </span>
      <span className="min-w-0 truncate text-caption font-medium text-muted-foreground">
        {t(`onboarding.step_nav.${key}.label`)}
      </span>
      {footer ? <span className="shrink-0">{footer}</span> : null}
    </div>
  );
}

export function StepSidebar({
  currentStep,
  onBack,
  backDisabled,
  onStepChange,
  footer,
}: {
  currentStep: OnboardingStep;
  onBack?: () => void;
  backDisabled?: boolean;
  /** Return to a step already passed. Injected by the flow, which owns
   *  the order of the steps; absent, the rail is purely indicative. */
  onStepChange?: (step: OnboardingStep) => void;
  /** Injected by the flow: the « Se déconnecter » exit. A slot
   *  rather than a direct render, so this component stays presentational. */
  footer?: ReactNode;
}) {
  const { t } = useT();
  const currentIndex = railIndex(currentStep);

  return (
    // Hidden below `md`, where it does not fit: the panel never went
    // under 15rem while the content panel kept its gutter, which
    // left ~87 px of form at 375 px. `StepProgressBar` carries the same
    // information, and this header's Back button, at these widths.
    <aside data-onboarding-rail="" className="hidden w-[15rem] shrink-0 p-2 md:block md:w-[19rem] md:p-3 lg:w-[22rem] lg:p-4">
      <div className="dark relative isolate flex h-full w-full flex-col overflow-hidden rounded-2xl bg-background px-5 pb-5 text-foreground ring-1 ring-border">
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-background">
          <DotSphere
            dotGap={19}
            motion="wave"
            sphereCount={5}
            sphereRadius="20%"
            dotRadiusMax={1.9}
            speed={0.4}
          />
        </div>

        <div className="relative flex min-h-0 flex-1 flex-col pt-5">
          <header className="flex min-h-9 shrink-0 items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2">
              <Wordmark className="size-5 shrink-0" />
              <span className="truncate text-label font-medium text-foreground">
                {t("onboarding.step_nav.wordmark")}
              </span>
            </span>
            {onBack ? (
              <ObButton
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={onBack}
                disabled={backDisabled}
                aria-label={t("onboarding.common.back")}
              >
                <ArrowLeft />
              </ObButton>
            ) : null}
          </header>

          <div className="flex min-h-0 flex-1 items-center justify-center py-10">
            <Stepper
              value={currentIndex + 1}
              orientation="vertical"
              role="group"
              aria-label={t("onboarding.step_nav.label")}
              className="flex w-full flex-col items-start justify-center gap-0"
            >
              <StepperNav className="w-full">
                {ONBOARDING_STEP_ORDER.map((stepId, index) => {
                  const isDone = index < currentIndex;
                  const isCurrent = index === currentIndex;
                  const isLast = index === ONBOARDING_STEP_ORDER.length - 1;
                  const canReturn = isDone && !!onStepChange && !backDisabled;
                  const key: RailStep = stepId;

                  const body = (
                    <>
                      <StepperIndicator
                        className={cn(
                          "mt-0.5 size-4 shrink-0 border-0 bg-transparent ring-1 transition-colors",
                          isDone
                            ? "bg-foreground text-background ring-foreground"
                            : isCurrent
                              ? "text-transparent ring-muted-foreground"
                              : "text-transparent ring-border",
                        )}
                      >
                        {isDone ? (
                          <Check aria-hidden className="size-3" />
                        ) : isCurrent ? (
                          <span aria-hidden className="block size-1.5 rounded-full bg-foreground" />
                        ) : (
                          <span className="sr-only">{index + 1}</span>
                        )}
                      </StepperIndicator>
                      <div className="min-w-0 flex-1 text-left">
                        <StepperTitle
                          className={cn(
                            "transition-colors",
                            isCurrent || isDone ? "text-foreground" : "text-muted-foreground",
                          )}
                        >
                          {t(`onboarding.step_nav.${key}.label`)}
                        </StepperTitle>
                        <StepperDescription className="mt-0.5 max-w-none text-muted-foreground">
                          {t(`onboarding.step_nav.${key}.description`)}
                        </StepperDescription>
                      </div>
                    </>
                  );

                  return (
                    <StepperItem
                      key={stepId}
                      step={index + 1}
                      completed={isDone}
                      className="relative w-full items-start not-last:flex-1"
                      {...(isCurrent ? { "aria-current": "step" as const } : {})}
                    >
                      {canReturn ? (
                        <button
                          type="button"
                          onClick={() => onStepChange(stepId)}
                          className="flex w-full items-start gap-3 rounded-md pb-6 text-left transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {body}
                        </button>
                      ) : (
                        <div
                          className={cn(
                            "flex w-full items-start gap-3 text-left",
                            !isLast && "pb-6",
                          )}
                        >
                          {body}
                        </div>
                      )}

                      {/* A continuous hairline BEHIND the row rather than a
                          segment between two, so the rail reads as
                          a single track. `-order-1` places it under the content. */}
                      {!isLast ? (
                        <StepperSeparator
                          className={cn(
                            "absolute left-2 top-6 -order-1 m-0 w-px -translate-x-1/2",
                            // The carried separator freezes a height of 3rem when
                            // vertical, which overflowed the row and crossed
                            // the next indicator. Same variant, so
                            // tailwind-merge drops theirs.
                            "group-data-[orientation=vertical]/stepper-nav:h-[calc(100%-1.75rem)]",
                            isDone ? "bg-muted-foreground" : "bg-border",
                          )}
                        />
                      ) : null}
                    </StepperItem>
                  );
                })}
              </StepperNav>
            </Stepper>
          </div>

          {footer ? (
            <footer className="flex min-h-8 shrink-0 items-end justify-between gap-4">
              {footer}
            </footer>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
