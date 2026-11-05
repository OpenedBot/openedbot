import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { api, queryKeys } from "../lib/api";
import { browserTitleEntity, browserTitleKey, formatBrowserTitle } from "../lib/shell/browser-title";
import { useT } from "../lib/i18n";

/**
 * Le titre court visible dans les onglets du navigateur de bureau.
 *
 * Les pages fixes reprennent le libellé traduit de leur navigation. Un fil
 * affiche le nom réel du bot ou du groupe, afin que plusieurs onglets openedbot
 * restent distinguables. Le titre de départ est posé à la construction
 * (Vite) : "openedbot (dev)" en serve, "openedbot" en production.
 */
export function BrowserTabMetadata() {
  const { pathname } = useLocation();
  const { t } = useT();
  const entity = browserTitleEntity(pathname);
  const roster = useQuery({
    queryKey: queryKeys.roster,
    queryFn: api.roster,
    enabled: entity !== null,
  });

  const entityName = entity?.kind === "bot"
    ? roster.data?.bots.find((bot) => bot.id === entity.id)?.name
    : roster.data?.groups?.find((group) => group.id === entity?.id)?.name;
  const staticKey = browserTitleKey(pathname);
  const fallback = entity?.kind === "bot"
    ? t("modeLanding.bot.nav")
    : entity?.kind === "group"
      ? t("appSidebar.conversationsGroup")
      : null;
  const title = formatBrowserTitle(entityName ?? (staticKey ? t(staticKey) : fallback));

  useEffect(() => {
    document.title = title;
  }, [title]);

  return null;
}
