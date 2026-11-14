import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage, queryKeys } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import { formatDate } from "../../../lib/format";
import { BUTTON, FIELD, ListSection, Note } from "../../../components/settings/primitives";

/** Identity-scoped: available without a workspace and never sends its header. */
export function AccountClosureSection() {
  const { t, locale } = useT();
  const client = useQueryClient();
  const [confirmationDraft, setConfirmationDraft] = useState({ planKey: "", value: "" });
  const state = useQuery({ queryKey: queryKeys.accountDeletion, queryFn: api.accountDeletion });
  const refresh = async () => {
    setConfirmationDraft({ planKey: "", value: "" });
    await client.invalidateQueries({ queryKey: queryKeys.accountDeletion });
  };
  const schedule = useMutation({
    mutationFn: (input: { confirmation: string; organizationIds: string[]; graceDays: number }) =>
      api.scheduleAccountDeletion(input.confirmation, input.organizationIds, input.graceDays),
    onSuccess: refresh,
    onError: () => void client.invalidateQueries({ queryKey: queryKeys.accountDeletion }),
  });
  const cancel = useMutation({ mutationFn: api.cancelAccountDeletion, onSuccess: refresh });
  const data = state.data;
  const pending = schedule.isPending || cancel.isPending;
  const error = state.error ?? schedule.error ?? cancel.error;
  const blocker = data?.blocker;
  const graceDays = data?.graceDays;
  const planKey = JSON.stringify({
    organizations: data?.organizations.map(({ id, name, action }) => ({ id, name, action })).sort((a, b) => a.id.localeCompare(b.id)),
    graceDays, eligible: data?.eligible, blocker, deletion: data?.deletion,
  });
  // Reset during render, not in a later effect: a changed preview never renders
  // with the previous DELETE, even if a subsequent refetch restores the old plan.
  const confirmation = confirmationDraft.planKey === planKey ? confirmationDraft.value : "";
  if (confirmationDraft.planKey !== planKey) setConfirmationDraft({ planKey, value: "" });
  const hasGracePeriod = typeof graceDays === "number" && Number.isInteger(graceDays) && graceDays >= 0;
  const canSchedule = data?.eligible === true && hasGracePeriod && !pending && confirmation === "DELETE";
  return (
    <ListSection title={t("settingsAccount.closureTitle")}>
      <div className="flex flex-col gap-3 p-4">
        <p className="text-sm text-muted-foreground">{t("settingsAccount.closureDescription")}</p>
        {error ? <Note tone="warning">{errorMessage(error, t("settingsAccount.closureRetry"))}</Note> : null}
        {state.isError ? <button type="button" className={BUTTON.secondary} onClick={() => void state.refetch()}>{t("settingsAccount.closureRetry")}</button> : null}
        {data ? <>
          {data.organizations.length ? <ul className="space-y-2 text-sm">
            {data.organizations.map((org) => <li key={org.id}>
              <strong>{org.name}</strong> — {t(org.action === "delete" ? "settingsAccount.closureDelete" : "settingsAccount.closureLeave")}
            </li>)}
          </ul> : <p className="text-sm">{t("settingsAccount.closureNoWorkspace")}</p>}
          {blocker ? <Note tone="warning">{t(blocker === "transfer_required" ? "settingsAccount.closureTransfer" : blocker === "active_subscription" ? "settingsAccount.closureSubscription" : "settingsAccount.closureTenantPending")}</Note> : null}
          {data.deletion ? <>
            <Note tone="warning">{t(data.deletion.inProgress ? "settingsAccount.closureProgress" : "settingsAccount.closurePending")}</Note>
            {data.deletion.purgeAfter ? <p className="text-sm">{t("settingsAccount.closureAfter")} {formatDate(data.deletion.purgeAfter, locale)}</p> : null}
            <button type="button" className={BUTTON.secondary} disabled={pending || data.deletion.inProgress} onClick={() => cancel.mutate()}>{t("settingsAccount.closureCancel")}</button>
          </> : <form className="flex flex-col gap-3" onSubmit={(event) => {
            event.preventDefault();
            if (canSchedule && typeof graceDays === "number") schedule.mutate({
              confirmation, graceDays,
              organizationIds: data.organizations.filter((org) => org.action === "delete").map((org) => org.id),
            });
          }}>
            {hasGracePeriod ? <Note tone="warning">{graceDays === 0
              ? t("settingsAccount.closureImmediate")
              : t("settingsAccount.closureGraceDays", { days: graceDays })}</Note>
              : <Note tone="warning">{t("settingsAccount.closureGraceUnavailable")}</Note>}
            <label htmlFor="account-closure-confirmation" className="text-sm">{t("settingsAccount.closureConfirmation")}</label>
            <input id="account-closure-confirmation" className={FIELD} autoComplete="off" value={confirmation} disabled={!data.eligible || !hasGracePeriod || pending} onChange={(event) => setConfirmationDraft({ planKey, value: event.target.value })} />
            <button type="submit" className={BUTTON.secondary} disabled={!canSchedule}>{t("settingsAccount.closureSubmit")}</button>
          </form>}
        </> : null}
      </div>
    </ListSection>
  );
}
