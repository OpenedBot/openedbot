import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Dialog } from "@openedbot/browser-ui-kit";
import { ApiError, api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { ThreadMarkdown } from "../thread-markdown";
import { BUTTON } from "../settings/primitives";

export function CreatePersonaSection({
  id,
  displayed,
  onEdit,
  onPendingChange,
  runtimeConnected,
  name,
  role,
  mission,
}: {
  id: string;
  displayed: string;
  onEdit: (next: string) => void;
  onPendingChange?: (pending: boolean) => void;
  runtimeConnected: boolean;
  name: string;
  role?: string | null;
  mission?: string | null;
}) {
  const { t } = useT();
  const [editing, setEditing] = useState(false);
  const [confirmingReplace, setConfirmingReplace] = useState(false);
  const propose = useMutation({
    mutationFn: async () => {
      const { runId } = await api.createPersonaDraft({
        name: name.trim() || "Bot",
        role: role?.trim() || null,
        mission: mission?.trim() || null,
      });
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const latest = await api.readPersonaDraft(runId);
        if (latest.status === "completed" && latest.draft) return latest.draft;
        if (latest.status === "failed" || latest.status === "cancelled") throw new Error(latest.status);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("timeout");
    },
    onMutate: () => onPendingChange?.(true),
    onSuccess: (draft) => onEdit(draft),
    onSettled: () => onPendingChange?.(false),
  });
  const hint = runtimeConnected
    ? t("newBotDialog.proposePersonaHint")
    : t("newBotDialog.proposePersonaNeedsRuntime");

  return (
    <section className="ohb-new-bot-sheet">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-text-primary">{t("newBotDialog.sheetTitle")}</h3>
        <button type="button" className={BUTTON.secondary} onClick={() => setEditing((value) => !value)}>
          {t(editing ? "newBotDialog.sheetPreview" : "newBotDialog.sheetEdit")}
        </button>
      </div>
      {editing ? (
        <textarea
          id={id}
          aria-label={t("newBotDialog.personaSection")}
          value={displayed}
          onChange={(event) => onEdit(event.target.value)}
          spellCheck={false}
          className="ohb-new-bot-persona-editor"
        />
      ) : (
        <div data-persona-preview="" className="ohb-new-bot-persona-preview">
          <ThreadMarkdown>{displayed}</ThreadMarkdown>
        </div>
      )}
      <div className="space-y-1.5">
        <button
          type="button"
          disabled={!runtimeConnected || propose.isPending}
          title={hint}
          aria-describedby={`${id}-propose-hint`}
          onClick={() => {
            if (displayed.trim()) setConfirmingReplace(true);
            else propose.mutate();
          }}
          className={BUTTON.secondary}
        >
          {propose.isPending ? t("newBotDialog.proposingPersona") : t("newBotDialog.sheetPropose")}
        </button>
        {propose.isError ? (
          <p className="text-sm text-destructive-text" role="alert">
            {propose.error instanceof ApiError ? propose.error.message : t("newBotDialog.proposePersonaFailed")}
          </p>
        ) : null}
        <p id={`${id}-propose-hint`} className="text-xs text-text-secondary">{hint}</p>
      </div>
      <Dialog
        open={confirmingReplace}
        onClose={() => setConfirmingReplace(false)}
        role="alertdialog"
        title={t("newBotDialog.proposePersonaConfirmTitle")}
        description={t("newBotDialog.proposePersonaConfirm")}
        swipeToDismiss={false}
        closeLabel={t("common.close")}
        footer={(
          <>
            <button type="button" className={BUTTON.secondary} onClick={() => setConfirmingReplace(false)}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className={BUTTON.primary}
              onClick={() => {
                setConfirmingReplace(false);
                propose.mutate();
              }}
            >
              {t("newBotDialog.proposePersonaOverwrite")}
            </button>
          </>
        )}
      />
    </section>
  );
}
