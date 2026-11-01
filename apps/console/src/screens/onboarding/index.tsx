import { useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { api, isApiUnavailable, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { hasCompletedOnboarding } from "../../lib/session/onboarding-gate";
import { OnboardingFlow } from "./onboarding-flow";

/**
 * L'écran d'accueil : les deux lectures dont le parcours a besoin pour se
 * rendre : l'état persistant (réponses, nom d'espace, sortie) et le roster
 * (les bots déjà là, le handle déjà choisi), puis le parcours lui-même.
 *
 * Le registre des runtimes, lui, est lu par l'étape qui s'en sert : c'est son
 * état « en cours de lecture » qui décide de sa phase de scan, et le cache de
 * TanStack Query le partage de toute façon.
 *
 * Un cloud API qui ne répond pas se DIT, il ne se devine pas : rendre le
 * parcours sur des données absentes ferait « aucun bot, aucune réponse »
 * d'une simple panne de l'API cloud.
 */
export function OnboardingScreen() {
  const { t } = useT();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { review?: number };
  const onboarding = useQuery({ queryKey: queryKeys.onboarding, queryFn: api.onboarding });
  const needsOrganization = onboarding.data?.needsOrganization === true;
  const roster = useQuery({
    queryKey: queryKeys.roster,
    queryFn: api.roster,
    enabled: onboarding.isSuccess && !needsOrganization,
  });

  /**
   * L'onboarding est PAR PERSONNE (`users.onboarding_completed`, exposé en
   * `completed`) : qui a déjà terminé le sien est renvoyé vers `/`, même si
   * l'espace, lui, n'est pas encore daté. Le gate de `route-tree.tsx` ne
   * protège que l'entrée automatique : cette garde-ci protège la route
   * ELLE-MÊME (lien direct, retour de login). `?review=1` est la seule
   * dérogation : le geste volontaire de l'overview.
   */
  const alreadyOnboarded = hasCompletedOnboarding(onboarding.data) && !search.review && !needsOrganization;
  useEffect(() => {
    if (alreadyOnboarded) void navigate({ to: "/", replace: true });
  }, [alreadyOnboarded, navigate]);
  if (alreadyOnboarded) return null;

  if (isApiUnavailable(onboarding.error) || isApiUnavailable(roster.error)) {
    return (
      <OnboardingWindow>
        <OnboardingNotice>
          <p
            role="status"
            className="rounded-xl border border-warn-700/40 bg-warn-soft px-3 py-2 text-caption leading-5 text-warn-700"
          >
            {t("onboarding.cloudApiDownNote")}
          </p>
        </OnboardingNotice>
      </OnboardingWindow>
    );
  }

  if (onboarding.isPending || (!needsOrganization && roster.isPending)) {
    return (
      <OnboardingWindow>
        <OnboardingNotice>
          <div
            role="status"
            aria-label={t("onboarding.loadingInstall")}
            className="flex w-full flex-col gap-3"
          >
            <div className="h-4 w-40 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <div className="h-10 w-full animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
            <div className="h-10 w-full animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
          </div>
        </OnboardingNotice>
      </OnboardingWindow>
    );
  }

  // Une erreur qui n'est PAS « cloud API éteint », un 401 en tête, ne doit
  // surtout pas fabriquer un état vierge : sur un espace déjà onboardé, ce
  // repli rendait le parcours complet à quiconque arrivait ici pendant une
  // erreur d'authentification. On la dit, on ne la maquille pas.
  if (onboarding.error || (!needsOrganization && roster.error)) {
    return (
      <OnboardingWindow>
        <OnboardingNotice>
          <p
            role="alert"
            className="rounded-xl border border-warn-700/40 bg-warn-soft px-3 py-2 text-caption leading-5 text-warn-700"
          >
            {t("onboarding.loadFailedNote")}
          </p>
        </OnboardingNotice>
      </OnboardingWindow>
    );
  }

  const state = onboarding.data;
  if (!state) return null;

  return (
    <OnboardingWindow>
      <OnboardingFlow state={state} roster={roster.data} />
    </OnboardingWindow>
  );
}

/**
 * La fenêtre du parcours, et la raison pour laquelle elle existe.
 *
 * `rootRoute` rend ses pages dans `<Shell>`, dont le `SidebarProvider` est un
 * conteneur `flex` en RANGÉE (`h-svh overflow-hidden`). Les racines portées de
 * Multica (`step-welcome.tsx`, `StepShell`) ne portent ni `w-full` ni
 * `flex-1` : chez Multica elles n'en ont pas besoin, le parcours y est monté
 * dans un conteneur pleine fenêtre. Ici, sans ce conteneur, l'écran d'accueil
 * se réduisait à la largeur de son contenu (~885 px) collé à gauche au lieu
 * des deux colonnes 50/50 attendues.
 *
 * Ce cadre est donc l'équivalent de leur conteneur de fenêtre, et il est posé
 * ICI plutôt qu'en ajoutant des classes aux racines portées : celles-ci
 * doivent rester mot pour mot celles de Multica, sinon la prochaine
 * comparaison avec la référence se fait sur du code qui a déjà divergé.
 *
 * `overflow-hidden` : le défilement appartient au corps de l'étape (le `main`
 * de `StepShell`), pas à la fenêtre : même règle que la coque de
 * l'application (`components/shell.tsx`).
 */
function OnboardingWindow({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-svh min-h-0 w-full flex-1 flex-col overflow-hidden bg-background">
      {children}
    </div>
  );
}

/** Le cadre des états d'avant-parcours : rien à ranger, une seule colonne. */
function OnboardingNotice({ children }: { children: ReactNode }) {
  return (
    <div className="scrollbar-subtle flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 py-10">
      <div className="flex w-full max-w-[28rem] flex-col gap-6">{children}</div>
    </div>
  );
}
