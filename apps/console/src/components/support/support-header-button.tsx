import { IconMessageCircle2 } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { Button, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, useIsMobile } from "@openedbot/browser-ui-kit";
import { useT } from "../../lib/i18n";
import { useOnSupportPage } from "../../lib/support/support-launcher-visibility";
import { useSupportDeskAvailable } from "../../lib/support/support-desk-availability";
import { useSupportUnread } from "../../lib/support/support-watch";
import { ChromeIconButton } from "../mobile/mobile-header";
import { SupportUnreadDot } from "./support-unread-dot";

/**
 * La porte du guichet dans l'en-tête de chaque écran de l'application : elle
 * mène à `/support`. Même place, même densité, même règle des 44 pt au doigt
 * que les autres commandes de l'en-tête. Sur `/support` elle se retire : on y
 * est déjà.
 */
export function SupportHeaderButton() {
  const { t, plural } = useT();
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const unread = useSupportUnread();
  const here = useOnSupportPage();
  const deskAvailable = useSupportDeskAvailable();
  if (here || !deskAvailable) return null;
  // Le nombre est DANS le libellé, pas seulement sur la pastille : au doigt
  // comme au lecteur d'écran, « Support (3 réponses non lues) » se lit, un
  // point rouge ne se lit pas.
  const label = unread > 0
    ? plural(unread, {
        one: t("support.launcherOpenUnread_one"),
        other: t("support.launcherOpenUnread_other"),
      })
    : t("support.launcherOpen");
  const open = () => void navigate({ to: "/support/{-$conversationId}", params: {} });

  const button = isMobile
    ? <ChromeIconButton label={label} icon={IconMessageCircle2} onClick={open} />
    : (
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-8"
        iconOnly
        leadingIcon={IconMessageCircle2}
        aria-label={label}
        title={label}
        onClick={open}
      />
    );

  // La pastille ne s'ajoute que s'il y a quelque chose à annoncer ; l'ancrage
  // relatif ne sert à rien sans elle.
  const withDot = unread === 0
    ? button
    : (
      <span className="relative inline-flex shrink-0">
        {button}
        <SupportUnreadDot count={unread} />
      </span>
    );

  // Au doigt, il n'y a pas de survol : l'infobulle ne se monte pas, et c'est
  // `aria-label` qui porte le sens.
  if (isMobile) return withDot;
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>{withDot}</TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
