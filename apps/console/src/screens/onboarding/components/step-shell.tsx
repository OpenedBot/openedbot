import { useLayoutEffect, useRef, type ReactNode } from "react";
import { cn } from "@openedbot/browser-ui-kit";
import { useScrollFade } from "@openedbot/browser-ui-kit/components/onboarding";
import { TITLEBAR_ANCHOR_ATTRIBUTE } from "@/lib/platform/native-titlebar";
import type { OnboardingStep } from "@/lib/session/onboarding";
import { StepProgressBar, StepSidebar } from "./step-sidebar";

/**
 * The steps' geometry, taken from Multica's ReUI onboarding-3 block so
 * the two panels read as one drawing.
 *
 * ONE measure, not three: a step that must leave it says so locally
 * rather than going to look up another global value.
 */
export const STEP_COLUMN = "mx-auto flex min-h-full w-full max-w-[28rem] flex-col";
export const STEP_GUTTER =
  "px-6 pt-8 pb-[max(2rem,var(--openedbot-safe-bottom))] sm:px-10 lg:px-14 lg:pt-10 lg:pb-[max(2.5rem,var(--openedbot-safe-bottom))]";

/**
 * A step's title and its supporting line.
 *
 * `aria-live` because the panels PERSIST from one step to the next: a
 * screen reader receives no navigation event when changing
 * step, so it is up to the title to announce itself.
 */
export function StepHeading({
  title,
  description,
}: {
  title: ReactNode;
  description?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5" aria-live="polite">
      <h1 className="text-balance text-title-lg font-semibold text-foreground">{title}</h1>
      {description ? (
        <p className="text-pretty text-body text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}

/**
 * The step's actions, pinned to the bottom of the column.
 *
 * Full-width stacked buttons rather than a row aligned to the right: the
 * column is 28rem, an inline bar would leave the main action
 * floating in the middle of the screen instead of landing where the eye finishes the
 * form. It is `mt-auto` against the column's `min-h-full` that pins it there.
 */
export function StepFooter({
  children,
  hint,
}: {
  children: ReactNode;
  /** Status line above the buttons (validation, progress). */
  hint?: ReactNode;
}) {
  return (
    <div className="mt-auto flex flex-col gap-2 pb-2 pt-10">
      {hint ? (
        <p aria-live="polite" className="text-caption text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {children}
    </div>
  );
}

/**
 * The frame in which each step renders: the progress rail on the left,
 * the step's content scrolling on the right.
 *
 * It owns the window, not only a banner: that is what keeps the
 * steps from repeating the same preamble, including the wiring of the scroll
 * gradient, set here a single time.
 *
 * The column is `min-h-full` INSIDE a panel that scrolls rather than centered
 * by it: `items-center` on a scroll container crops the top of
 * anything that exceeds the window, and these steps overflow on a short screen.
 */
export function StepShell({
  currentStep,
  onBack,
  backDisabled,
  onStepChange,
  chromeFooter,
  children,
}: {
  currentStep: OnboardingStep;
  onBack?: () => void;
  /** « Organisation » and « Espace de travail » disarm Back while they save. */
  backDisabled?: boolean;
  /** Return to a step already passed, from the rail. */
  onStepChange?: (step: OnboardingStep) => void;
  /** Injected by the flow: the « Se déconnecter » exit. Rendered in the
   *  visible chrome: the rail from `md`, the compact bar below. */
  chromeFooter?: ReactNode;
  children: ReactNode;
}) {
  const mainRef = useRef<HTMLElement>(null);
  const fadeStyle = useScrollFade(mainRef);
  // The macOS traffic lights go to this screen's own title bar row (above
  // the rail card), centred on it. The app's frame may have left them in its
  // rail card's head row (`BoardFrame`, « card »), which lands them on this
  // rail card's corner instead.
  useLayoutEffect(() => {
    document.documentElement.setAttribute(TITLEBAR_ANCHOR_ATTRIBUTE, "bar");
  }, []);

  return (
    <div className="animate-onboarding-enter flex h-full min-h-0 flex-col bg-background">
      {/* The native shell's title bar: empty and hidden outside it
          (`native-titlebar.css`), it keeps the macOS traffic lights and the Windows
          buttons out of the rail, and serves as the window's drag handle. */}
      <div data-onboarding-titlebar="" data-titlebar-drag="" aria-hidden />
      <div className="flex min-h-0 flex-1">
        <StepSidebar
          currentStep={currentStep}
          onBack={onBack}
          backDisabled={backDisabled}
          onStepChange={onStepChange}
          footer={chromeFooter}
        />

        <main
          ref={mainRef}
          style={fadeStyle}
          className={cn("scrollbar-subtle min-h-0 min-w-0 flex-1 overflow-y-auto", STEP_GUTTER)}
        >
          <div className={STEP_COLUMN}>
            <StepProgressBar
              currentStep={currentStep}
              onBack={onBack}
              backDisabled={backDisabled}
              footer={chromeFooter}
            />
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
