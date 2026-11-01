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
 * Le parcours d'accueil : d'un poste vierge à un runtime prêt (machine,
 * fournisseur d'IA, modèle), sans ouvrir de terminal. Le premier bot se crée
 * ensuite dans l'application.
 *
 * L'étape courante vit ICI, et un brouillon local la suit
 * (`lib/session/onboarding-draft.ts`) : un rafraîchissement en plein parcours doit
 * rendre l'écran où on l'a laissé, pas renvoyer à l'accueil. Ce que le cloud
 * API connaît (le nom de l'espace, le handle, la sortie,
 * `OnboardingStateDto`) reste lu chez lui ; le brouillon ne porte que ce
 * que le serveur ignore, et s'efface à la sortie du parcours comme à la
 * déconnexion.
 *
 * UNE coque pour tout le parcours, rendue ici plutôt que par chaque étape.
 * Chaque étape rendait sa propre `StepShell` chez Multica, et comme chaque
 * étape est un composant DIFFÉRENT, React démontait la coque et en construisait
 * une neuve à chaque transition, remontant le rail « persistant », relançant
 * son canvas, rejouant le fondu depuis l'opacité 0. Ce re-fondu plein écran
 * EST le clignotement. Hisser la coque ici rend le rail réellement persistant
 * et ne laisse changer que le corps de l'étape.
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
  // Une seule lecture du brouillon : l'étape que le F5 doit rendre.
  const [restored] = useState(readOnboardingDraft);
  const hasOrganization = state.needsOrganization !== true;
  const organizationReset = state.organizationReset === true;
  const [step, setStep] = useState<OnboardingStep>(() => {
    if (organizationReset) return "workspace";
    // Sans organisation propre, seul l'espace de travail peut la créer.
    if (!hasOrganization) return restored?.step === "welcome" ? "welcome" : "workspace";
    return restored?.step ?? "welcome";
  });
  // Levé par l'étape qui a une requête en vol ; verrouille Retour et le rail.
  // « Espace de travail » le pose pendant son envoi.
  const [stepBusy, setStepBusy] = useState(false);

  /** Changer d'étape, c'est aussi le dire au brouillon : les deux ne divergent jamais. */
  const goToStep = useCallback((next: OnboardingStep) => {
    setStep(next);
    writeOnboardingDraft({ step: next });
  }, []);

  const bots = roster?.bots ?? [];
  // « J'ai déjà fait ça » n'a de sens que s'il y a quelque chose où atterrir :
  // sans un seul bot, passer laisserait l'opérateur devant une application vide
  // sans lui avoir rien demandé.
  const canSkipWelcome = bots.length > 0;

  const advanceFrom = useCallback((from: OnboardingStep) => {
    const next = nextStep(from);
    if (next) goToStep(next);
  }, [goToStep]);

  const handleBack = useCallback((from: OnboardingStep) => {
    const previous = prevStep(from);
    if (previous) goToStep(previous);
  }, [goToStep]);

  /** Marque le parcours terminé côté cloud API, et relit ce que ça a changé. */
  const complete = useCallback(
    async (path: OnboardingCompletionPath) => {
      await api.completeOnboarding(path);
      // Le parcours est sorti : le brouillon n'a plus rien à rendre, et le
      // laisser ferait reprendre une entrée suivante à mi-chemin.
      clearOnboardingDraft();
      await queryClient.invalidateQueries({ queryKey: queryKeys.onboarding });
      toast.success(t("onboarding.completion.success"));
    },
    [queryClient, t],
  );

  // « J'ai déjà fait ça » : l'opérateur qui a déjà des bots et veut juste
  // atterrir. Idempotent côté cloud API ; ne crée rien.
  const handleWelcomeSkip = useCallback(async () => {
    try {
      await complete("skip_existing");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("onboarding.errors.skip_failed"));
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [complete, navigate, t]);

  /** Le runtime est configuré : marquer l'accueil terminé et ouvrir l'application. */
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
    // L'accueil n'a pas de rail : la sortie y reste épinglée.
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
      // Le rail ne marche QUE vers l'arrière : les étapes franchies sont des
      // liens, les suivantes du texte : avancer exige de jouer la validation
      // et l'envoi de l'étape courante, que le rail contournerait.
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
