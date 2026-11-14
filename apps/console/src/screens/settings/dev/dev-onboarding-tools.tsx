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
 * Development tools: the card exists only if the cloud API has published
 * `devSignIn` on `/api/auth/providers`, that is in OPENEDBOT_ENV=development
 * and nowhere else: the same switch as « Remplir (dev) » on the
 * sign-in door, and the same as the one that MOUNTS `/api/onboarding/reset`
 * on the API side. A production build can therefore neither show the buttons nor
 * reach the route.
 *
 * Two gestures, two scopes, and that is the only difference between them:
 *
 * - « Rejouer l'onboarding » (`scope: "flag"`) sets the person's flag back to
 *   `false` and clears the exit from the current workspace. Nothing is destroyed: the
 *   bots and the discussions are still there on return.
 * - « Repartir de zéro » (`scope: "full"`) also empties the local database's
 *   application data (bots, discussions, runs, runtimes) while
 *   keeping the user, the organization, the membership and the session.
 *   Destructive: it goes through an explicit confirmation, in the same
 *   idiom as « révoquer les autres sessions » (`security.tsx`): a
 *   `Dialog role="alertdialog"`, not a browser `confirm()`. The gesture
 *   itself lives in `components/settings/dev-onboarding-restart.tsx`: the
 *   settings sidebar offers it too, above « Mon compte ».
 *
 * After an emptying, invalidating only the `onboarding` key would lie: the roster,
 * the discussions, the runtimes and the connectors have just disappeared
 * too. ALL of the react-query cache is therefore invalidated before leaving for
 * `/onboarding`, where the flow starts again from step 0.
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
