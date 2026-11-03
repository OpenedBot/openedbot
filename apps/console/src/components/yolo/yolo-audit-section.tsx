import { useInfiniteQuery } from "@tanstack/react-query";
import type { YoloAuditEntryDto } from "@openedbot/contracts-api";
import { api, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { ACTIONS, BUTTON, CardHeading, Note, SettingsCard } from "../settings/primitives";
import { useCanManageYolo, yoloErrorMessage } from "./yolo-shared";

/** Un hash se lit par son début : assez pour le reconnaître, la valeur entière reste au survol. */
function shortHash(value: string): string {
  return value.length > 16 ? `${value.slice(0, 12)}…` : value;
}

/**
 * « Auto-approuvés (YOLO) » dans le journal de sécurité : ce que l'hôte a
 * approuvé seul sous un bail, remonté au retour du lien. Outil, type de
 * porte, hash des arguments (jamais leur contenu), date et bail. Owner et
 * admin seulement, comme la route : un membre ne voit pas la section.
 */
export function YoloAuditSection() {
  const { t } = useT();
  const canManage = useCanManageYolo();
  const audit = useInfiniteQuery({
    queryKey: queryKeys.yoloAudit,
    queryFn: ({ pageParam }) => api.yoloAudit(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: canManage,
    retry: false,
  });
  if (!canManage) return null;
  const entries: YoloAuditEntryDto[] = audit.data?.pages.flatMap((page) => page.entries) ?? [];

  return (
    <SettingsCard className="space-y-3" data-yolo-audit="">
      <CardHeading title={t("yolo.auditTitle")} description={t("yolo.auditDescription")} />
      {audit.isPending ? <p role="status" className="text-sm text-muted-foreground">{t("yolo.auditLoading")}</p> : null}
      {audit.isError ? <Note tone="danger" role="alert">{yoloErrorMessage(audit.error, t, t("yolo.auditFailed"))}</Note> : null}
      {audit.data && entries.length === 0 ? <p className="text-sm text-muted-foreground">{t("yolo.auditEmpty")}</p> : null}
      {entries.length > 0 ? <AuditTable entries={entries} /> : null}
      {audit.hasNextPage ? (
        <div className={ACTIONS}>
          <button type="button" className={BUTTON.small} disabled={audit.isFetchingNextPage} onClick={() => void audit.fetchNextPage()}>
            {t("yolo.auditMore")}
          </button>
        </div>
      ) : null}
    </SettingsCard>
  );
}

function AuditTable({ entries }: { entries: readonly YoloAuditEntryDto[] }) {
  const { t, formatDate } = useT();
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">{t("yolo.auditColumns.date")}</th>
            <th scope="col" className="px-3 py-2 font-medium">{t("yolo.auditColumns.tool")}</th>
            <th scope="col" className="px-3 py-2 font-medium">{t("yolo.auditColumns.gate")}</th>
            <th scope="col" className="px-3 py-2 font-medium">{t("yolo.auditColumns.args")}</th>
            <th scope="col" className="px-3 py-2 font-medium">{t("yolo.auditColumns.lease")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {entries.map((entry) => (
            <tr key={entry.id} data-yolo-audit-entry={entry.id}>
              <td className="whitespace-nowrap px-3 py-2">{formatDate(entry.occurredAt)}</td>
              <td className="px-3 py-2 font-mono text-xs">{entry.toolKey ?? "—"}</td>
              <td className="px-3 py-2 font-mono text-xs">{entry.gateKind}</td>
              <td className="px-3 py-2 font-mono text-xs" title={entry.argsHash}>{shortHash(entry.argsHash)}</td>
              <td className="px-3 py-2 font-mono text-xs" title={entry.leaseId}>{shortHash(entry.leaseId)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
