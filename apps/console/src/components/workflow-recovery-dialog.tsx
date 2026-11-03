import { Dialog } from "@openedbot/browser-ui-kit";
import { useT } from "../lib/i18n";
import type { useWorkflowRecovery } from "../lib/run/use-workflow-recovery";
import { BUTTON } from "./settings/primitives";

/**
 * Confirmation `abandon` / `retry` : un alertdialog, pas `window.confirm`.
 */
export function WorkflowRecoveryDialog({
  recovery,
}: {
  recovery: ReturnType<typeof useWorkflowRecovery>;
}) {
  const { t } = useT();
  const pending = recovery.confirming;
  const danger = pending?.action === "retry";

  return (
    <Dialog
      open={pending !== null}
      onClose={recovery.cancel}
      role="alertdialog"
      title={pending?.action === "retry" ? t("workflowOverview.retry") : t("workflowOverview.abandon")}
      description={
        pending?.action === "retry"
          ? t("workflowOverview.confirmRetry")
          : t("workflowOverview.confirmAbandon")
      }
      closeLabel={t("common.close")}
      footer={
        <>
          <button
            type="button"
            disabled={recovery.isPending}
            onClick={recovery.cancel}
            className={BUTTON.secondary}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={recovery.isPending}
            onClick={recovery.confirm}
            className={danger ? BUTTON.danger : BUTTON.confirm}
          >
            {recovery.isPending
              ? t("workflowOverview.working")
              : pending?.action === "retry"
                ? t("workflowOverview.retry")
                : t("common.confirm")}
          </button>
        </>
      }
    >
      {recovery.isError ? (
        <p className="text-destructive-text">
          {recovery.error instanceof Error ? recovery.error.message : t("workflowOverview.actionFailed")}
        </p>
      ) : null}
    </Dialog>
  );
}
