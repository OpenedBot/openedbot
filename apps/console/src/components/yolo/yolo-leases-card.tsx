import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RiFlashlightFill } from "@remixicon/react";
import type { BotDto, YoloLeaseDto } from "@openedbot/contracts-api";
import { toast } from "@openedbot/browser-ui-kit";
import { api, queryKeys } from "../../lib/api";
import { formatCountdown, useCountdown } from "../../lib/countdown";
import { useT } from "../../lib/i18n";
import { ACTIONS, BUTTON, CardHeading, Note, SettingsCard, ToneBadge } from "../settings/primitives";
import { YoloKillButton } from "./yolo-kill-button";
import { invalidateYolo, useCanManageYolo, useYoloLeases, yoloErrorMessage, yoloReachable } from "./yolo-shared";

const HOST_TONE = { pending: "neutral", active: "warning", expired: "neutral", revoked: "neutral", rejected: "danger" } as const;

/**
 * Les baux YOLO vivants, chacun avec son compte à rebours et, pour owner et
 * admin, « Couper » ; puis « Couper YOLO partout ». Sur la page Politiques
 * (toute l'organisation, à côté du plafond) et dans l'onglet Runtime
 * (`runtimeId` : ceux de ce runtime). Un membre les lit sans pouvoir agir.
 */
export function YoloLeasesCard({ runtimeId }: { runtimeId?: string }) {
  const { t } = useT();
  const canManage = useCanManageYolo();
  const leases = useYoloLeases(runtimeId ? { runtimeId } : {});
  const roster = useQuery({ queryKey: queryKeys.roster, queryFn: api.roster, enabled: yoloReachable() });
  if (!yoloReachable()) return null;
  const bots = roster.data?.bots ?? [];
  const rows = leases.data?.leases ?? [];

  return (
    <SettingsCard className="space-y-3" data-yolo-leases="">
      <CardHeading
        title={t("yolo.cardTitle")}
        description={t(runtimeId ? "yolo.cardRuntimeDescription" : "yolo.cardDescription")}
        action={<RiFlashlightFill aria-hidden className="size-5 text-muted-foreground" />}
      />
      {leases.isPending ? <p role="status" className="text-sm text-muted-foreground">{t("yolo.leasesLoading")}</p> : null}
      {leases.isError ? <Note tone="danger" role="alert">{yoloErrorMessage(leases.error, t, t("yolo.leasesFailed"))}</Note> : null}
      {leases.data && rows.length === 0 ? <p className="text-sm text-muted-foreground">{t("yolo.leasesEmpty")}</p> : null}
      {rows.length > 0 ? (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {rows.map((lease) => <LeaseRow key={lease.id} lease={lease} bots={bots} canManage={canManage} />)}
        </ul>
      ) : null}
      {canManage ? (
        <div className={ACTIONS}><YoloKillButton /></div>
      ) : (
        <p className="text-xs text-muted-foreground">{t("yolo.managersOnly")}</p>
      )}
    </SettingsCard>
  );
}

function LeaseRow({ lease, bots, canManage }: { lease: YoloLeaseDto; bots: readonly BotDto[]; canManage: boolean }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const { remainingMs } = useCountdown(lease.expiresAt);
  const name = bots.find((bot) => bot.id === lease.botId)?.name ?? t("yolo.unknownBot");
  const target = t(`yolo.leaseTarget.${lease.scope}`, { name });
  const revoke = useMutation({
    mutationFn: () => api.revokeYoloLease(lease.id),
    onSuccess: async () => {
      toast.success(t("yolo.revoked"));
      await invalidateYolo(queryClient);
    },
    onError: (error) => toast.error(yoloErrorMessage(error, t, t("yolo.revokeFailed"))),
  });
  return (
    <li data-yolo-lease={lease.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-text-primary">{target}</span>
        <span className="block text-xs tabular-nums text-muted-foreground">
          {remainingMs > 0 ? t("yolo.leaseRemaining", { time: formatCountdown(remainingMs) }) : t("yolo.expired")}
        </span>
      </span>
      <ToneBadge tone={HOST_TONE[lease.hostState]}>{t(`yolo.hostState.${lease.hostState}`)}</ToneBadge>
      {canManage ? (
        <button
          type="button"
          className={BUTTON.small}
          disabled={revoke.isPending}
          aria-label={t("yolo.revokeAria", { target })}
          onClick={() => revoke.mutate()}
        >
          {revoke.isPending ? t("yolo.revoking") : t("yolo.revoke")}
        </button>
      ) : null}
    </li>
  );
}
