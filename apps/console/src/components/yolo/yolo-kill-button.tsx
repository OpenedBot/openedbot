import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, toast } from "@openedbot/browser-ui-kit";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { BUTTON } from "../settings/primitives";
import { invalidateYolo, useCanManageYolo, yoloErrorMessage } from "./yolo-shared";

/**
 * « Couper YOLO partout » (`POST /kill`) : tous les baux de l'organisation,
 * chaque runtime prévenu. Owner et admin seulement ; un membre ne voit pas
 * le bouton. Confirmation `alertdialog`, jamais un `confirm()` du navigateur :
 * Annuler ne poste rien. Le geste reste offert sans bail connu ici : un hôte
 * peut tenir un bail que le cloud croit échu, et le kill le prévient aussi.
 */
export function YoloKillButton({ className }: { className?: string }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const canManage = useCanManageYolo();
  const [confirming, setConfirming] = useState(false);
  const kill = useMutation({
    mutationFn: () => api.killYolo(),
    onSuccess: async (result) => {
      setConfirming(false);
      toast.success(t("yolo.killed", { revoked: result.revoked, runtimes: result.runtimes }));
      await invalidateYolo(queryClient);
    },
  });
  if (!canManage) return null;
  const cancel = () => {
    if (!kill.isPending) {
      setConfirming(false);
      kill.reset();
    }
  };
  return (
    <>
      <button type="button" className={className ?? BUTTON.danger} data-yolo-kill="" onClick={() => setConfirming(true)}>
        {t("yolo.killAction")}
      </button>
      {confirming ? (
        <Dialog
          open
          onClose={cancel}
          role="alertdialog"
          title={t("yolo.killTitle")}
          description={t("yolo.killDescription")}
          closeLabel={t("common.close")}
          swipeToDismiss={false}
          footer={(
            <>
              <button type="button" className={BUTTON.secondary} disabled={kill.isPending} onClick={cancel}>
                {t("common.cancel")}
              </button>
              <button type="button" className={BUTTON.danger} disabled={kill.isPending} onClick={() => kill.mutate()}>
                {kill.isPending ? t("yolo.killing") : t("yolo.killConfirm")}
              </button>
            </>
          )}
        >
          {kill.error ? (
            <p role="alert" className="text-destructive-text">{yoloErrorMessage(kill.error, t, t("yolo.killFailed"))}</p>
          ) : null}
        </Dialog>
      ) : null}
    </>
  );
}
