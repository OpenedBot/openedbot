import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { activeFleetId, activeOrganizationId } from "../../lib/cloud-session";
import { useFallbackT } from "../../lib/i18n";
import { clearPersistedQueries } from "../../lib/query-persister";

/** Hide a refused frame immediately, including cached values, while the account guard finds the next destination. */
export function WorkspaceAccessBoundary({ children }: { children: ReactNode }) {
  // Rendered above or around a failing provider tree during a 502: the
  // fallback reads the loaded catalog when no I18nProvider is mounted.
  const { t } = useFallbackT();
  const queryClient = useQueryClient();
  const organizationId = activeOrganizationId();
  const fleetId = activeFleetId();
  const [revoked, setRevoked] = useState(false);
  useEffect(() => {
    const onRevoked = (event: Event) => {
      const detail = (event as CustomEvent<{ organizationId: string; fleetId: string | null }>).detail;
      if (detail.organizationId !== organizationId || detail.fleetId !== fleetId) return;
      setRevoked(true);
      queryClient.clear();
      void clearPersistedQueries();
    };
    window.addEventListener("ohb:workspace-revoked", onRevoked);
    return () => window.removeEventListener("ohb:workspace-revoked", onRevoked);
  }, [organizationId, fleetId, queryClient]);
  return revoked ? <p role="alert" className="p-4 text-sm text-muted-foreground">{t("common.workspaceAccessRevoked")}</p> : children;
}
