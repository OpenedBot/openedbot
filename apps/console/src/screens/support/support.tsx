import { useCallback, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { SiteHeader } from "../../components/dashboard/site-header";
import { SupportPanel } from "../../components/support/support-panel";
import { useT } from "../../lib/i18n";
import { SUPPORT_ROUTE_ID } from "../../lib/support-launcher-visibility";

/**
 * Le guichet dans l'application : `/support`, et `/support/:id` pour un fil.
 *
 * Une page, pas un canva ni une modale : le guichet se posait à côté du fil
 * ou sous la modale des réglages, selon d'où on l'ouvrait. Ici l'URL dit quel
 * fil est à l'écran, le retour ramène au précédent, et un lien vers une
 * réponse du staff ouvre la bonne conversation. La liste des fils est celle
 * du panneau (`view: "history"`) : une seule façon de les retrouver.
 */
export function SupportScreen() {
  const { t } = useT();
  const navigate = useNavigate();
  const { conversationId } = useParams({ from: SUPPORT_ROUTE_ID });
  const [headerActions, setHeaderActions] = useState<ReactNode>(null);
  const onPageActions = useCallback((actions: ReactNode) => {
    setHeaderActions(actions);
  }, []);
  const onConversationChange = useCallback(
    (next: string | null, { replace }: { replace: boolean }) => {
      if ((next ?? undefined) === conversationId) return;
      void navigate({
        to: "/support/{-$conversationId}",
        params: { conversationId: next ?? undefined },
        replace,
      });
    },
    [conversationId, navigate],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SiteHeader title={t("support.title")} actions={headerActions} />
      <SupportPanel
        variant="page"
        conversationId={conversationId ?? null}
        onConversationChange={onConversationChange}
        onPageActions={onPageActions}
      />
    </div>
  );
}
