import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { api, queryKeys } from "../lib/api";
import { browserTitleEntity, browserTitleKey, formatBrowserTitle } from "../lib/shell/browser-title";
import { useT } from "../lib/i18n";

/**
 * The short title visible in desktop browser tabs.
 *
 * Fixed pages reuse the translated label of their navigation. A thread
 * shows the real name of the bot or the group, so that several openedbot tabs
 * stay distinguishable. The starting title is set at build
 * (Vite): "openedbot (dev)" in serve, "openedbot" in production.
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
