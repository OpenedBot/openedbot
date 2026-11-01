import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../api";

export type WorkflowRecoveryAction = "reconcile" | "abandon" | "retry";
export type WorkflowRecoveryConfirm = { workflowId: string; action: "abandon" | "retry" };

/**
 * Les trois actions de récupération d'un workflow (`reconcile` / `abandon` /
 * `retry`). `abandon` et `retry` n'exécutent pas tout de suite : l'appelant
 * pose un `alertdialog` via `confirm` / `cancel`. Jamais `window.confirm`.
 */
export function useWorkflowRecovery({ onSuccess }: { onSuccess: () => void }) {
  const [confirming, setConfirming] = useState<WorkflowRecoveryConfirm | null>(null);
  const recovery = useMutation({
    mutationFn: async ({
      workflowId,
      action,
    }: {
      workflowId: string;
      action: WorkflowRecoveryAction;
    }) => {
      if (action === "reconcile") return api.reconcileWorkflow(workflowId);
      if (action === "abandon") return api.abandonWorkflow(workflowId);
      return api.retryWorkflow(workflowId);
    },
    onSuccess: () => {
      setConfirming(null);
      onSuccess();
    },
  });

  const act = (workflowId: string, action: WorkflowRecoveryAction) => {
    if (action === "reconcile") {
      recovery.mutate({ workflowId, action });
      return;
    }
    setConfirming({ workflowId, action });
  };

  return {
    act,
    confirming,
    confirm: () => {
      if (!confirming || recovery.isPending) return;
      recovery.mutate(confirming);
    },
    cancel: () => {
      if (recovery.isPending) return;
      setConfirming(null);
    },
    isPending: recovery.isPending,
    variables: recovery.variables,
    isError: recovery.isError,
    error: recovery.error,
  };
}
