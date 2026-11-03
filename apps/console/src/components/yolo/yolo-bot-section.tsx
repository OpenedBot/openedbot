import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { yoloPolicyBlock, type BotDto } from "@openedbot/contracts-api";
import { toast } from "@openedbot/browser-ui-kit";
import { api } from "../../lib/api";
import { formatCountdown, useCountdown } from "../../lib/countdown";
import { useT } from "../../lib/i18n";
import { BUTTON, Note } from "../settings/primitives";
import { usePermissionContext } from "../boardui/permission-picker";
import { YoloBadge } from "./yolo-badge";
import { YoloGrantDialog } from "./yolo-grant-dialog";
import {
  invalidateYolo,
  useCanManageYolo,
  useThreadYoloLease,
  useYoloLeases,
  yoloErrorMessage,
  yoloIgnoredReason,
  yoloReachable,
} from "./yolo-shared";

function useRevokeLease() {
  const { t } = useT();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (leaseId: string) => api.revokeYoloLease(leaseId),
    onSuccess: async () => {
      toast.success(t("yolo.revoked"));
      await invalidateYolo(queryClient);
    },
    onError: (error) => toast.error(yoloErrorMessage(error, t, t("yolo.revokeFailed"))),
  });
}

/**
 * La rubrique YOLO de la fiche du bot (Règles d'approbation) : le bail qui
 * le couvre et son compte à rebours, « Activer YOLO » (portée bot ou runtime)
 * pour owner et admin, et chaque raison qui empêche YOLO de s'appliquer,
 * dite en clair : la politique de l'organisation refuse l'octroi, ou un
 * bail court mais la porte l'ignore (Mode plan, plafond, revue imposée).
 */
export function YoloBotSection({ bot }: { bot: BotDto }) {
  const { t } = useT();
  const context = usePermissionContext();
  const canManage = useCanManageYolo();
  const revoke = useRevokeLease();
  const [granting, setGranting] = useState(false);
  const leases = useYoloLeases({ botId: bot.id });
  if (!yoloReachable()) return null;

  const mode = bot.permissionMode ?? "manual";
  const cover = bot.effectivePermission?.yolo ?? null;
  const block = context ? yoloPolicyBlock(context) : null;
  // A lease that runs on this bot (its own, or the runtime's) without covering it.
  const uncovered = cover ? null : leases.data?.leases.find((lease) =>
    (lease.scope === "bot" && lease.botId === bot.id) || lease.scope === "runtime") ?? null;
  const ignored = uncovered ? yoloIgnoredReason(mode, context) : null;

  return (
    <section className="space-y-2 rounded-xl border border-border p-3" data-yolo-bot="" aria-labelledby={`yolo-bot-${bot.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`yolo-bot-${bot.id}`} className="text-sm font-medium text-text-primary">{t("yolo.botSectionTitle")}</h3>
        {cover ? <YoloBadge leaseId={cover.leaseId} expiresAt={cover.expiresAt} scope={cover.scope} /> : null}
      </div>
      <p className="text-xs leading-5 text-text-tertiary">{t("yolo.botSectionIntro")}</p>
      {cover ? <ActiveLine scope={cover.scope} expiresAt={cover.expiresAt} /> : (
        <p className="text-xs leading-5 text-text-secondary">{t("yolo.botInactive")}</p>
      )}
      {ignored ? <Note tone="warning" role="status">{t(`yolo.leaseIgnored.${ignored}`)}</Note> : null}
      {block && !ignored ? <Note tone="info" role="status">{t(`yolo.blocked.${block}`)}</Note> : null}
      {canManage ? (
        <div className="flex flex-wrap gap-2">
          {cover ? (
            <button type="button" className={BUTTON.secondary} disabled={revoke.isPending} onClick={() => revoke.mutate(cover.leaseId)}>
              {revoke.isPending ? t("yolo.revoking") : t("yolo.revoke")}
            </button>
          ) : null}
          <button type="button" className={BUTTON.secondary} data-yolo-grant-open="" disabled={block !== null} onClick={() => setGranting(true)}>
            {t("yolo.grantAction")}
          </button>
        </div>
      ) : (
        <p className="text-xs text-text-tertiary">{t("yolo.managersOnly")}</p>
      )}
      <YoloGrantDialog open={granting} onClose={() => setGranting(false)} scopes={["bot", "runtime"]} botId={bot.id} />
    </section>
  );
}

function ActiveLine({ scope, expiresAt }: { scope: "thread" | "bot" | "runtime"; expiresAt: string }) {
  const { t } = useT();
  const { remainingMs } = useCountdown(expiresAt);
  return (
    <p className="text-xs leading-5 text-text-secondary">
      {t("yolo.botActive", { scope: t(`yolo.scope.${scope}`), time: formatCountdown(remainingMs) })}
    </p>
  );
}

/**
 * L'entrée « Activer YOLO dans cette conversation » du menu de l'en-tête
 * (portée thread, 4 h par défaut), ou « Couper » quand un bail y court.
 * Owner et admin seulement : `item` est `null` pour un membre. La boîte vit
 * hors du menu (`dialog`), qui se referme au clic.
 */
export function useYoloThreadAction({
  botId,
  threadId,
  closeMenu,
  itemClassName,
  icon,
}: {
  botId: string;
  threadId: string | null | undefined;
  closeMenu: () => void;
  itemClassName: string;
  icon: ReactNode;
}): { item: ReactNode; dialog: ReactNode } {
  const { t } = useT();
  const canManage = useCanManageYolo();
  const lease = useThreadYoloLease(canManage ? threadId : null);
  const revoke = useRevokeLease();
  const [open, setOpen] = useState(false);
  if (!canManage || !threadId) return { item: null, dialog: null };
  const item = (
    <button
      type="button"
      data-yolo-thread-action={lease ? "revoke" : "grant"}
      className={itemClassName}
      disabled={revoke.isPending}
      onClick={() => {
        closeMenu();
        if (lease) revoke.mutate(lease.id);
        else setOpen(true);
      }}
    >
      {icon}
      {t(lease ? "yolo.revokeThreadAction" : "yolo.grantThreadAction")}
    </button>
  );
  const dialog = <YoloGrantDialog open={open} onClose={() => setOpen(false)} scopes={["thread"]} botId={botId} threadId={threadId} />;
  return { item, dialog };
}
