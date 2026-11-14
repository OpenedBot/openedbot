import { useCallback, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@openedbot/browser-ui-kit";
import { nextStep, prevStep, type OnboardingStep } from "@/lib/session/onboarding";
import type { OnboardingCompletionPath, OnboardingStateDto, RosterDto } from "@openedbot/contracts-api";
import { api, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import {
  clearOnboardingDraft,
  readOnboardingDraft,
  writeOnboardingDraft,
} from "../../lib/session/onboarding-draft";
import { StepShell } from "./components/step-shell";
import { OnboardingLogoutButton } from "./components/onboarding-logout-button";
import { StepWelcome } from "./steps/step-welcome";
import { StepWorkspace } from "./steps/step-workspace";
import { StepRuntime } from "./steps/step-runtime";

/**
 * The welcome flow: from a blank workstation to a ready runtime (machine,
 * AI provider, model), without opening a terminal. The first bot is created
 * afterwards in the application.
 *
 * The current step lives HERE, and a local draft follows it
 * (`lib/session/onboarding-draft.ts`): a refresh in the middle of the flow must
 * render the screen where one left it, not send back to the welcome. What the cloud
 * API knows (the workspace name, the handle, the exit,
 * `OnboardingStateDto`) stays read from it; the draft carries only what
 * the server ignores, and clears on leaving the flow as on
 * sign-out.
 *
 * ONE shell for the whole flow, rendered here rather than by each step.
 * Each step rendered its own `StepShell` at Multica, and since each
 * step is a DIFFERENT component, React unmounted the shell and built
 * a new one on every transition, remounting the "persistent" rail, restarting
 * its canvas, replaying the fade from opacity 0. That full-screen re-fade
 * IS the flicker. Hoisting the shell here makes the rail really persistent
 * and lets only the step's body change.
 */
export function OnboardingFlow({
  state,
  roster,
}: {
  state: OnboardingStateDto;
  roster: RosterDto | undefined;
}) {
  const { t } = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // A single read of the draft: the step F5 must render.
  const [restored] = useState(readOnboardingDraft);
  const hasOrganization = state.needsOrganization !== true;
  const organizationReset = state.organizationReset === true;
  const [step, setStep] = useState<OnboardingStep>(() => {
    if (organizationReset) return "workspace";
    // With no organization of one's own, only the workspace step can create it.
    if (!hasOrganization) return restored?.step === "welcome" ? "welcome" : "workspace";
    return restored?.step ?? "welcome";
  });
  // Raised by the step that has a request in flight; locks Back and the rail.
  // « Espace de travail » sets it while it sends.
  const [stepBusy, setStepBusy] = useState(false);

  /** Changing step also tells the draft: the two never diverge. */
  const goToStep = useCallback((next: OnboardingStep) => {
    setStep(next);
    writeOnboardingDraft({ step: next });
  }, []);

  const bots = roster?.bots ?? [];
  // « J'ai déjà fait ça » makes sense only if there is something to land on:
  // without a single bot, skipping would leave the operator in front of an empty application
  // without having asked them anything.
  const canSkipWelcome = bots.length > 0;

  const advanceFrom = useCallback((from: OnboardingStep) => {
    const next = nextStep(from);
    if (next) goToStep(next);
  }, [goToStep]);

  const handleBack = useCallback((from: OnboardingStep) => {
    const previous = prevStep(from);
    if (previous) goToStep(previous);
  }, [goToStep]);

  /** Marks the flow finished on the cloud API side, and rereads what that changed. */
  const complete = useCallback(
    async (path: OnboardingCompletionPath) => {
      await api.completeOnboarding(path);
      // The flow has been left: the draft has nothing left to render, and
      // leaving it would make a later entry resume halfway.
      clearOnboardingDraft();
      await queryClient.invalidateQueries({ queryKey: queryKeys.onboarding });
      toast.success(t("onboarding.completion.success"));
    },
    [queryClient, t],
  );

  // « J'ai déjà fait ça »: the operator who already has bots and just wants to
  // land. Idempotent on the cloud API side; creates nothing.
  const handleWelcomeSkip = useCallback(async () => {
    try {
      await complete("skip_existing");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("onboarding.errors.skip_failed"));
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [complete, navigate, t]);

  /** The runtime is configured: mark the welcome finished and open the application. */
  const handleFinish = useCallback(async () => {
    try {
      await complete("full");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("onboarding.errors.skip_failed"));
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [complete, navigate, t]);

  const handleRuntimeSkip = useCallback(async () => {
    try {
      await complete("runtime_skipped");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("onboarding.errors.skip_failed"));
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [complete, navigate, t]);

  if (step === "welcome") {
    // The welcome has no rail: the exit stays pinned there.
    return (
      <>
        <OnboardingLogoutButton />
        <StepWelcome
          onNext={() => advanceFrom("welcome")}
          onSkip={canSkipWelcome ? handleWelcomeSkip : undefined}
        />
      </>
    );
  }

  return (
    <StepShell
      currentStep={step}
      onBack={() => handleBack(step)}
      backDisabled={stepBusy}
      // The rail walks ONLY backward: the steps already passed are
      // links, the later ones text: moving forward requires playing the validation
      // and the send of the current step, which the rail would bypass.
      onStepChange={goToStep}
      chromeFooter={<OnboardingLogoutButton inline />}
    >
      {step === "workspace" && (
        <StepWorkspace
          created={hasOrganization}
          organizationReset={organizationReset}
          workspaceName={organizationReset ? null : state.workspaceName}
          operator={roster?.operator}
          pendingUsername={restored?.pendingUsername ?? null}
          pendingUsernameError={restored?.pendingUsernameError ?? null}
          onBusyChange={setStepBusy}
          onAdvance={() => advanceFrom("workspace")}
        />
      )}

      {step === "runtime" && <StepRuntime onFinish={handleFinish} onSkip={handleRuntimeSkip} />}
    </StepShell>
  );
}
