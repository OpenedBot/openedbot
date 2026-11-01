import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Dialog } from "@openedbot/browser-ui-kit";
import { BUTTON } from "./primitives";
import { api, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { clearOnboardingDraft } from "../../lib/session/onboarding-draft";

/**
 * « Repartir de zéro » : le geste de développement qui vide les données
 * applicatives de la base locale (bots, discussions, runs, runtimes) en
 * gardant le compte, l'organisation et la session, puis rejoue l'accueil
 * depuis l'étape 0 (`POST /api/onboarding/reset` avec `{"scope":"full"}`).
 *
 * Il est ici, et pas dans un écran, parce que TROIS surfaces l'offrent : la
 * carte des outils de dev (`screens/settings/dev/dev-onboarding-tools.tsx`), le
 * pied de la barre latérale des réglages et son jumeau mobile. Un
 * geste destructeur ne se recopie pas : une seule mutation, une seule
 * confirmation, une seule invalidation.
 */

/**
 * L'interrupteur, et le seul : le cloud API publie `devSignIn` sur
 * `/api/auth/providers` en `OHB_ENV=development` et nulle part ailleurs.
 * C'est le même qui MONTE la route ; un build de production ne peut donc ni
 * montrer le geste ni l'atteindre. Le champ porte les identifiants du compte
 * de dev : sa PRÉSENCE est le booléen, jamais sa valeur.
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
 * Après le vidage, invalider la seule clé `onboarding` mentirait : le roster,
 * les discussions, les runtimes et les connecteurs viennent de disparaître eux
 * aussi. On invalide donc TOUT le cache avant de partir sur `/onboarding`.
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
 * La confirmation : `Dialog role="alertdialog"`, l'idiome des gestes
 * destructeurs des réglages (`screens/settings/journal/security.tsx`), jamais un
 * `confirm()` du navigateur. Annuler ne poste rien.
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
