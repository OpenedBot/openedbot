import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api, queryKeys } from "../../../lib/api";
import { BUTTON, CardHeading, Note, SettingsCard } from "../../../components/settings/primitives";
import {
  DevOnboardingRestartDialog,
  useDevOnboardingAvailable,
  useDevOnboardingRestart,
} from "../../../components/settings/dev-onboarding-restart";
import { useT } from "../../../lib/i18n";

/**
 * Outils de développement : la carte n'existe que si le cloud API a publié
 * `devSignIn` sur `/api/auth/providers`, c'est-à-dire en OHB_ENV=development
 * et nulle part ailleurs : le même interrupteur que « Remplir (dev) » de la
 * porte de connexion, et le même que celui qui MONTE `/api/onboarding/reset`
 * côté API. Un build de production ne peut donc ni montrer les boutons ni
 * atteindre la route.
 *
 * Deux gestes, deux portées, et c'est la seule différence entre eux :
 *
 * - « Rejouer l'onboarding » (`scope: "flag"`) remet le flag de la personne à
 *   `false` et efface la sortie de l'espace courant. Rien n'est détruit : les
 *   bots et les discussions sont toujours là au retour.
 * - « Repartir de zéro » (`scope: "full"`) vide en plus les données
 *   applicatives de la base locale (bots, discussions, runs, runtimes) en
 *   conservant l'utilisateur, l'organisation, l'appartenance et la session.
 *   Destructeur : il passe par une confirmation explicite, dans le même
 *   idiome que « révoquer les autres sessions » (`security.tsx`) : un
 *   `Dialog role="alertdialog"`, pas un `confirm()` du navigateur. Le geste
 *   lui-même vit dans `components/settings/dev-onboarding-restart.tsx` : la
 *   barre latérale des réglages l'offre aussi, au-dessus de « Mon compte ».
 *
 * Après un vidage, invalider la seule clé `onboarding` mentirait : le roster,
 * les discussions, les runtimes et les connecteurs viennent de disparaître
 * eux aussi. On invalide donc TOUT le cache react-query avant de partir sur
 * `/onboarding`, où le parcours repart de l'étape 0.
 */
export function DevOnboardingTools() {
  const { t } = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const devAvailable = useDevOnboardingAvailable();
  const wipe = useDevOnboardingRestart();

  const reset = useMutation({
    mutationFn: () => api.resetOnboarding(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.onboarding });
      await navigate({ to: "/onboarding" });
    },
  });

  if (!devAvailable) return null;

  return (
    <SettingsCard className="space-y-4" data-testid="dev-onboarding-tools">
      <CardHeading
        title={t("settingsProfile.devToolsTitle")}
        description={t("settingsProfile.devToolsDescription")}
      />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={BUTTON.danger}
          disabled={reset.isPending || wipe.isPending}
          onClick={() => reset.mutate()}
        >
          {reset.isPending ? t("settingsProfile.devResetOnboardingPending") : t("settingsProfile.devResetOnboarding")}
        </button>
        <button
          type="button"
          className={BUTTON.danger}
          disabled={reset.isPending || wipe.isPending}
          onClick={wipe.ask}
        >
          {wipe.isPending ? t("settingsProfile.devWipeWorkspacePending") : t("settingsProfile.devWipeWorkspace")}
        </button>
      </div>
      <Note tone="warning">{t("settingsProfile.devWipeWorkspaceDescription")}</Note>
      {reset.error ? (
        <Note tone="danger" role="alert">
          {reset.error instanceof Error ? reset.error.message : t("settingsProfile.devResetOnboardingError")}
        </Note>
      ) : null}
      {wipe.error ? (
        <Note tone="danger" role="alert">
          {wipe.error instanceof Error ? wipe.error.message : t("settingsProfile.devWipeWorkspaceError")}
        </Note>
      ) : null}
      <DevOnboardingRestartDialog restart={wipe} />
    </SettingsCard>
  );
}
