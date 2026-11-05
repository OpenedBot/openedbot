import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconShieldLock } from "@tabler/icons-react";
import {
  normalizeCommandBlocklist,
  type OrganizationPermissionPolicyDto,
  type OrganizationPermissionPolicyView,
  type PermissionCeiling,
  type PermissionRulesMode,
} from "@openedbot/contracts-api";
import { api, userFacingError } from "../../lib/api";
import { activeFleetId, activeOrganizationId } from "../../lib/session/cloud-session";
import { useT } from "../../lib/i18n";
import { ACTIONS, BUTTON, CardHeading, FIELD, Note, SettingsCard, StatusList, StatusRow } from "./primitives";
import { FieldsetRow, SegmentedRadio } from "./segmented";

/**
 * PERM2-8: the organization's permission policy on the
 * « Politiques » page. Every member reads it; owners and admins edit it. An
 * agency acting on a client never sees it: the API refuses every
 * `/api/organization*` route to an agency (D-5).
 *
 * The server is the authority: the ceiling, the blocklist rules and the role
 * are checked again by the API and by `set_organization_permission_policy`.
 * The local check only says early what the server would refuse.
 */

type Draft = {
  maxMode: PermissionCeiling | null;
  enforceReview: boolean;
  rulesMode: PermissionRulesMode;
  blocklistText: string;
};

const CEILING_OPTIONS = [
  { value: null, key: "orgPermissionPolicy.ceilingNone" },
  { value: "manual", key: "orgPermissionPolicy.ceilingManual" },
  { value: "auto", key: "orgPermissionPolicy.ceilingAuto" },
  { value: "bypass", key: "orgPermissionPolicy.ceilingBypass" },
] as const satisfies ReadonlyArray<{ value: PermissionCeiling | null; key: string }>;

function draftOf(policy: OrganizationPermissionPolicyDto): Draft {
  return {
    maxMode: policy.maxMode,
    enforceReview: policy.enforceReview,
    rulesMode: policy.rulesMode,
    blocklistText: policy.commandBlocklist.join("\n"),
  };
}

/** Lines as typed; blank lines are layout, not entries. */
function blocklistLines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "");
}

export function OrganizationPermissionPolicySettings({
  mobile = false,
  onMobileFooterChange,
}: {
  mobile?: boolean;
  onMobileFooterChange?: (footer: ReactNode | null) => void;
} = {}) {
  const organizationId = activeOrganizationId();
  const fleetContext = Boolean(activeFleetId());
  useEffect(() => {
    if (fleetContext || !organizationId) onMobileFooterChange?.(null);
  }, [fleetContext, organizationId, onMobileFooterChange]);
  if (fleetContext || !organizationId) return null;
  return <ScopedPolicy key={organizationId} organizationId={organizationId} mobile={mobile} onMobileFooterChange={onMobileFooterChange} />;
}

function ScopedPolicy({
  organizationId,
  mobile,
  onMobileFooterChange,
}: {
  organizationId: string;
  mobile: boolean;
  onMobileFooterChange?: (footer: ReactNode | null) => void;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["organization-permission-policy", organizationId], [organizationId]);
  const query = useQuery({
    queryKey,
    queryFn: () => api.organizationPermissionPolicy(),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const view = query.data;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftVersion, setDraftVersion] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger" | "info"; text: string } | null>(null);
  const saveRef = useRef<() => void>(() => {});

  // The draft follows the policy each time a new version is read (first
  // load, a save, a reload after a conflict), never on every render.
  if (view && view.policy.version !== draftVersion) {
    setDraftVersion(view.policy.version);
    setDraft(draftOf(view.policy));
  }

  const lines = draft ? blocklistLines(draft.blocklistText) : [];
  const blocklist = normalizeCommandBlocklist(lines);
  const blocklistError = blocklist.ok ? null : blocklist.index === null
    ? t("orgPermissionPolicy.blocklistIssue.too_many")
    : t("orgPermissionPolicy.blocklistInvalid", {
        line: String(blocklist.index + 1),
        reason: t(`orgPermissionPolicy.blocklistIssue.${blocklist.issue}`),
      });
  const canEdit = Boolean(view?.canEdit && view.enforced);
  // The saved policy decides: an existing non-default review setup is visible on load.
  const reviewConfigured = Boolean(view && (view.policy.enforceReview || view.policy.rulesMode === "replaces"));
  const dirty = Boolean(view && draft && (
    draft.maxMode !== view.policy.maxMode
    || draft.enforceReview !== view.policy.enforceReview
    || draft.rulesMode !== view.policy.rulesMode
    || draft.blocklistText !== view.policy.commandBlocklist.join("\n")
  ));

  const save = async () => {
    if (!view || !draft || !canEdit || saving || !blocklist.ok) return;
    setSaving(true);
    setMessage(null);
    try {
      const saved: OrganizationPermissionPolicyView = await api.saveOrganizationPermissionPolicy({
        maxMode: draft.maxMode,
        enforceReview: draft.enforceReview,
        rulesMode: draft.rulesMode,
        commandBlocklist: blocklist.entries,
        expectedVersion: view.policy.version,
      });
      queryClient.setQueryData(queryKey, saved);
      setDraftVersion(saved.policy.version);
      setDraft(draftOf(saved.policy));
      setMessage({ tone: "success", text: t("orgPermissionPolicy.saved") });
    } catch (error) {
      setMessage({ tone: "danger", text: userFacingError(error, t("orgPermissionPolicy.saveFailed")) });
      void query.refetch();
    } finally {
      setSaving(false);
    }
  };
  saveRef.current = () => { void save(); };

  const saveDisabled = saving || !dirty || !blocklist.ok;
  const mobileFooter = useMemo(() => {
    if (!mobile || !canEdit) return null;
    return <button type="button" className={BUTTON.primary} disabled={saveDisabled} onClick={() => saveRef.current()}>
      {saving ? t("orgPermissionPolicy.saving") : t("orgPermissionPolicy.save")}
    </button>;
  }, [canEdit, mobile, saveDisabled, saving, t]);
  useEffect(() => {
    onMobileFooterChange?.(mobileFooter);
    return () => onMobileFooterChange?.(null);
  }, [mobileFooter, onMobileFooterChange]);

  const ceilingLabel = (value: PermissionCeiling | null) =>
    t((CEILING_OPTIONS.find((option) => option.value === value) ?? CEILING_OPTIONS[0]).key);

  return (
    <SettingsCard className="space-y-4">
      <CardHeading
        id="organization-permission-policy-title"
        title={t("orgPermissionPolicy.title")}
        description={t("orgPermissionPolicy.description")}
        action={<IconShieldLock className="size-5 text-muted-foreground" aria-hidden="true" />}
      />

      {query.isPending && <p role="status" className="text-sm text-muted-foreground">{t("orgPermissionPolicy.loading")}</p>}
      {query.isError && (
        <div className="flex flex-wrap items-center gap-3">
          <Note tone="info" role="alert">{userFacingError(query.error, t("orgPermissionPolicy.readFailed"))}</Note>
          <button type="button" className={BUTTON.small} onClick={() => void query.refetch()}>{t("orgPermissionPolicy.retry")}</button>
        </div>
      )}

      {view && !view.enforced && <Note tone="info" role="status">{t("orgPermissionPolicy.notEnforced")}</Note>}

      {view && draft && !canEdit && (
        <>
          <StatusList className="rounded-xl border border-border">
            <StatusRow label={t("orgPermissionPolicy.ceilingLabel")} value={ceilingLabel(view.policy.maxMode)} />
            <StatusRow
              label={t("orgPermissionPolicy.blocklistLabel")}
              value={view.policy.commandBlocklist.length ? view.policy.commandBlocklist.join(", ") : t("orgPermissionPolicy.blocklistEmpty")}
            />
            <StatusRow
              label={t("orgPermissionPolicy.enforceReviewLabel")}
              value={t(view.policy.enforceReview ? "orgPermissionPolicy.enforceReviewOn" : "orgPermissionPolicy.enforceReviewOff")}
            />
            <StatusRow
              label={t("orgPermissionPolicy.rulesModeLabel")}
              value={t(view.policy.rulesMode === "replaces" ? "orgPermissionPolicy.rulesModeReplaces" : "orgPermissionPolicy.rulesModeAdds")}
            />
          </StatusList>
          {!view.canEdit && <p className="text-sm text-muted-foreground">{t("orgPermissionPolicy.readOnly")}</p>}
        </>
      )}

      {view && draft && canEdit && (
        <form
          className="space-y-5"
          aria-labelledby="organization-permission-policy-title"
          onSubmit={(event) => { event.preventDefault(); void save(); }}
        >
          <FieldsetRow legend={t("orgPermissionPolicy.ceilingLabel")} hint={t("orgPermissionPolicy.ceilingHint")} disabled={saving}>
            <SegmentedRadio
              name="organization-permission-ceiling"
              options={CEILING_OPTIONS.map((option) => ({ value: option.value, label: t(option.key) }))}
              value={draft.maxMode}
              onChange={(maxMode) => setDraft({ ...draft, maxMode })}
            />
          </FieldsetRow>

          <div className="space-y-2">
            <label htmlFor="organization-permission-blocklist" className="block text-sm font-medium">
              {t("orgPermissionPolicy.blocklistLabel")}
            </label>
            <p id="organization-permission-blocklist-hint" className="text-xs text-muted-foreground">
              {t("orgPermissionPolicy.blocklistHint")}
            </p>
            <textarea
              id="organization-permission-blocklist"
              className={`${FIELD} block min-h-28 w-full text-base sm:text-sm`}
              rows={5}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              disabled={saving}
              aria-describedby={blocklistError ? "organization-permission-blocklist-hint organization-permission-blocklist-error" : "organization-permission-blocklist-hint"}
              aria-invalid={blocklistError ? true : undefined}
              value={draft.blocklistText}
              onChange={(event) => setDraft({ ...draft, blocklistText: event.currentTarget.value })}
            />
            {blocklistError && (
              <p id="organization-permission-blocklist-error" role="alert" className="text-xs text-destructive-text">{blocklistError}</p>
            )}
          </div>

          <details className="space-y-3 rounded-xl border border-border p-3" open={reviewConfigured}>
            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">{t("orgPermissionPolicy.reviewAdvancedTitle")}</summary>
            <p className="mt-2 text-xs text-muted-foreground">{t("orgPermissionPolicy.reviewAdvancedIntro")}</p>
            <div className="mt-3 space-y-5">
              <fieldset className="space-y-2" disabled={saving}>
                <legend className="text-sm font-medium">{t("orgPermissionPolicy.enforceReviewLabel")}</legend>
                <label className="inline-flex items-center gap-2 py-1 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.enforceReview}
                    onChange={(event) => setDraft({ ...draft, enforceReview: event.currentTarget.checked })}
                  />
                  {t("orgPermissionPolicy.enforceReviewHint")}
                </label>
              </fieldset>

              <FieldsetRow legend={t("orgPermissionPolicy.rulesModeLabel")} hint={t("orgPermissionPolicy.rulesModeHint")} disabled={saving}>
                <SegmentedRadio
                  name="organization-permission-rules-mode"
                  options={(["adds", "replaces"] as const).map((value) => ({
                    value,
                    label: t(value === "adds" ? "orgPermissionPolicy.rulesModeAdds" : "orgPermissionPolicy.rulesModeReplaces"),
                  }))}
                  value={draft.rulesMode}
                  onChange={(rulesMode) => setDraft({ ...draft, rulesMode })}
                />
              </FieldsetRow>
            </div>
          </details>

          {!mobile && (
            <div className={ACTIONS}>
              <button type="submit" className={BUTTON.primary} disabled={saveDisabled}>
                {saving ? t("orgPermissionPolicy.saving") : t("orgPermissionPolicy.save")}
              </button>
            </div>
          )}
        </form>
      )}

      {message && <Note tone={message.tone} role={message.tone === "success" ? "status" : "alert"}>{message.text}</Note>}
    </SettingsCard>
  );
}
