import { useEffect, useState } from "react";
import { Dialog } from "@openedbot/browser-ui-kit";
import { useT } from "../../lib/i18n";
import { BUTTON } from "../settings/primitives";

/** « Objectif » du menu « + » : une phrase qui précède chaque message du fil. */
export function GoalDialog({
  open,
  initial,
  onClose,
  onSave,
}: {
  open: boolean;
  initial: string | null;
  onClose: () => void;
  onSave: (goal: string | null) => void;
}) {
  const { t } = useT();
  const [value, setValue] = useState(initial ?? "");
  useEffect(() => {
    if (open) setValue(initial ?? "");
  }, [open, initial]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("boardui.goalTitle")}
      description={t("boardui.goalDescription")}
      closeLabel={t("common.close")}
      className="max-w-md"
      footer={
        <>
          <button type="button" className={BUTTON.secondary} onClick={onClose}>{t("common.cancel")}</button>
          <button type="button" className={BUTTON.primary} onClick={() => onSave(value)}>
            {value.trim() ? t("boardui.goalSave") : t("boardui.clearGoal")}
          </button>
        </>
      }
    >
      <textarea
        autoFocus
        rows={3}
        maxLength={280}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={t("boardui.goalPlaceholder")}
        aria-label={t("boardui.goal")}
        className="block w-full resize-none rounded-2lg bg-background-tertiary-default px-2.5 py-2 text-body-regular text-text-primary outline-none ring-2 ring-inset ring-transparent placeholder:text-text-tertiary focus-visible:ring-border-focus-ring"
      />
    </Dialog>
  );
}
