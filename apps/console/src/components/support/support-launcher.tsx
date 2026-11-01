import { useEffect } from "react";
import { useRouterState } from "@tanstack/react-router";
import { IconMessageCircle2 } from "@tabler/icons-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@openedbot/browser-ui-kit";
import { useT } from "../../lib/i18n";
import { isSupportLauncherVisible, useOnSupportPage } from "../../lib/support-launcher-visibility";
import {
  closeSupportPanel,
  openSupportPanel,
  useSupportPanelOpen,
} from "../../lib/support-panel-session";
import { useSupportDeskAvailable } from "../../lib/support-desk-availability";
import { useSupportUnread, useSupportWatch } from "../../lib/support-watch";
import { SupportPanel } from "./support-panel";
import { SupportUnreadDot } from "./support-unread-dot";

const LAUNCHER_CLASS =
  "ohb-support-launcher fixed right-[max(1.5rem,var(--ohb-safe-right))] bottom-[max(1.5rem,var(--ohb-safe-bottom))] z-40 flex size-12 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-[var(--shadow-elevated)] transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none active:scale-95";

/**
 * La bulle du guichet, montée par la racine de l'arbre de routes.
 *
 * La bulle ne se montre que hors de l'application : page publique,
 * connexion, légal, onboarding (`support-launcher-visibility.ts`). Dans
 * l'application, le guichet est la page `/support`.
 *
 * La carte n'est montée qu'à l'ouverture : tant que personne ne la demande,
 * ni flux SSE, ni lecture de `localStorage`, ni requête. Une bulle ne doit
 * rien coûter à la page qui la porte.
 */
export function SupportLauncher() {
  const { t, plural } = useT();
  const open = useSupportPanelOpen();
  const onSupportPage = useOnSupportPage();
  // `landing` est posé par le `beforeLoad` du cadre applicatif : `/` sans
  // session rend la page publique. La bulle le lit dans les matches, elle est
  // montée au-dessus de ce cadre.
  const launcherVisible = useRouterState({
    select: (state) => isSupportLauncherVisible(
      state.matches.map((match) => match.routeId),
      state.matches.some((match) => (match.context as { landing?: boolean } | undefined)?.landing === true),
    ),
  });
  /**
   * Le guetteur vit ICI, et pas dans la bulle rendue.
   *
   * La bulle se retire de l'application, et la carte n'est montée qu'à
   * l'ouverture : ni l'une ni l'autre ne peut porter une veille. Ce
   * composant, lui, est monté par la racine des routes sur TOUS les écrans, y
   * compris ceux où il ne rend rien. Les hooks sont donc appelés avant tout
   * retour anticipé, sans quoi la veille s'arrêterait en entrant dans l'app.
   * Sur `/support`, c'est la page qui tient le fil : le guetteur se retire.
   */
  // Without a desk (solo), the watcher stands down like on `/support`: no
  // desk request at all, so no 404 at load.
  const deskAvailable = useSupportDeskAvailable();
  useSupportWatch(open || onSupportPage || !deskAvailable);
  const unread = useSupportUnread();
  // Une carte ouverte sur `/login` ne survit pas à la connexion : l'app n'a
  // pas de bulle. Laisser `open` à vrai couperait la veille pour de bon.
  useEffect(() => {
    if (!launcherVisible) closeSupportPanel();
  }, [launcherVisible]);

  if (!launcherVisible || !deskAvailable) return null;
  // Ouverte, la bulle disparaît : la carte couvre le coin où elle se tient,
  // donc la laisser montée n'offrirait qu'une cible invisible au clavier et au
  // lecteur d'écran. La carte porte son propre bouton de fermeture.
  if (open) return <SupportPanel onClose={closeSupportPanel} variant="card" />;

  const label = unread > 0
    ? plural(unread, {
        one: t("support.launcherOpenUnread_one"),
        other: t("support.launcherOpenUnread_other"),
      })
    : t("support.launcherOpen");

  return (
    /* Son propre `TooltipProvider`, comme la bulle d'installation : la bulle
       se monte aussi hors de la coque (un test, une capture), et un `Tooltip`
       sans fournisseur ne dégrade pas, il jette. `delayDuration` à zéro parce
       qu'une bulle ronde sans libellé ne dit rien tant que l'infobulle n'est
       pas là : la faire attendre une seconde, c'est la cacher. */
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => openSupportPanel()}
            aria-label={label}
            className={LAUNCHER_CLASS}
          >
            <IconMessageCircle2 aria-hidden className="size-6" />
            <SupportUnreadDot count={unread} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="left">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
