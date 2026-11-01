import { useState, type CSSProperties } from "react";
import { LogOut } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@openedbot/browser-ui-kit";
import { ObButton } from "@openedbot/browser-ui-kit/components/onboarding";
import { api, queryKeys } from "../../../lib/api";
import { signOut } from "../../../lib/sign-out";
import { useT } from "../../../lib/i18n";

/**
 * La sortie « changer de compte », partagée par toutes les étapes.
 *
 * `fixed` seulement pour l'accueil, qui n'a pas de rail où la poser. Toutes
 * les autres étapes passent `inline` : elle chevauche alors le pied du rail,
 * épinglée au coin de la fenêtre, elle sortait de la mesure et se lisait
 * comme une seconde rangée d'en-tête au-dessus de Retour.
 *
 * Le rail confine `.dark` à son propre panneau : les tokens muted/foreground
 * y résolvent déjà contre une surface sombre, aucun utilitaire inversé n'est
 * nécessaire.
 *
 * Absente hors session SSO : un jeton propriétaire n'a pas de session à
 * révoquer, et le bouton ramènerait sur `/login` sans rien à y faire.
 */
export function OnboardingLogoutButton({
  inline = false,
}: {
  /** Rendu dans le flux (au pied du rail) plutôt qu'épinglé. */
  inline?: boolean;
} = {}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe, retry: false });

  if (me.data?.kind !== "session") return null;

  return (
    <ObButton
      variant="ghost"
      size="sm"
      disabled={pending}
      className={cn(
        inline
          ? "-ml-2 w-fit shrink-0 text-muted-foreground hover:text-foreground"
          : "fixed top-[max(2rem,env(safe-area-inset-top))] right-[max(2rem,env(safe-area-inset-right))] z-50 text-muted-foreground hover:text-destructive-text",
      )}
      style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
      onClick={() => {
        setPending(true);
        void signOut(queryClient).finally(() => setPending(false));
      }}
    >
      <LogOut />
      {t("onboarding.common.log_out")}
    </ObButton>
  );
}
