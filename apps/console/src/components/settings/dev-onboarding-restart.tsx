import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Dialog } from "@openedbot/browser-ui-kit";
import { BUTTON } from "./primitives";
import { api, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { clearOnboardingDraft } from "../../lib/session/onboarding-draft";

/**
 * « Repartir de zéro »: the development gesture that empties the local
 * database's application data (bots, discussions, runs, runtimes) while
 * keeping the account, the organization and the session, then replays home
 * from step 0 (`POST /api/onboarding/reset` with `{"scope":"full"}`).
 *
 * It is here, and not in a screen, because THREE surfaces offer it: the
 * dev tools card (`screens/settings/dev/dev-onboarding-tools.tsx`), the
 * foot of the settings sidebar and its mobile twin. A
 * destructive gesture is not copied: one mutation, one
 * confirmation, one invalidation.
 */

/**
 * The switch, and the only one: the cloud API publishes `devSignIn` on
 * `/api/auth/providers` in `OPENEDBOT_ENV=development` and nowhere else.
 * It is the same one that MOUNTS the route; a production build can therefore neither
 * show the gesture nor reach it. The field carries the dev account's
 * identifiers: its PRESENCE is the boolean, never its value.
 */
export function useDevOnboardingAvailable(): boolean {
  const providers = useQuery({ queryKey: queryKeys.authProviders, queryFn: api.authProviders });
  return providers.data?.devSignIn !== undefined;
}

type DevOnboardingRestart = {
  confirming: boolean;
  isPending: boolean;
  error: unknown;
  ask: () => void;
  cancel: () => void;
  run: () => void;
};

/**
 * After the emptying, invalidating only the `onboarding` key would lie: the roster,
 * the discussions, the runtimes and the connectors have just disappeared
 * too. So the WHOLE cache is invalidated before leaving for `/onboarding`.
 */
export function useDevOnboardingRestart(): DevOnboardingRestart {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const wipe = useMutation({
    mutationFn: () => api.resetOnboarding("full"),
    onSuccess: async () => {
      setConfirming(false);
      clearOnboardingDraft();
      await queryClient.invalidateQueries();
      await navigate({ to: "/onboarding" });
    },
  });

  return {
    confirming,
    isPending: wipe.isPending,
    error: wipe.error,
    ask: () => setConfirming(true),
    cancel: () => {
      if (!wipe.isPending) setConfirming(false);
    },
    run: () => wipe.mutate(),
  };
}

/**
 * The confirmation: `Dialog role="alertdialog"`, the idiom of settings'
 * destructive gestures (`screens/settings/journal/security.tsx`), never a
 * browser `confirm()`. Cancelling posts nothing.
 */
export function DevOnboardingRestartDialog({ restart }: { restart: DevOnboardingRestart }) {
  const { t } = useT();
  if (!restart.confirming) return null;

  return (
    <Dialog
      open
      onClose={restart.cancel}
      role="alertdialog"
      title={t("settingsProfile.devWipeWorkspaceConfirmTitle")}
      description={t("settingsProfile.devWipeWorkspaceConfirmDescription")}
      closeLabel={t("common.close")}
      footer={
        <>
          <button type="button" className={BUTTON.secondary} disabled={restart.isPending} onClick={restart.cancel}>
            {t("common.cancel")}
          </button>
          <button type="button" className={BUTTON.danger} disabled={restart.isPending} onClick={restart.run}>
            {restart.isPending
              ? t("settingsProfile.devWipeWorkspacePending")
              : t("settingsProfile.devWipeWorkspaceConfirm")}
          </button>
        </>
      }
    />
  );
}
