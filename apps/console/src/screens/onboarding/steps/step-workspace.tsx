import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { normalizeUsername, usernameProblem } from "@openedbot/identity/domain/operator";
import type { OperatorProfileDto } from "@openedbot/contracts-api";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  ObButton,
  ObInput,
} from "@openedbot/browser-ui-kit/components/onboarding";
import { ApiError, api, errorMessage, queryKeys } from "../../../lib/api";
import { activeOrganizationId, readCloudSession, saveCloudSession } from "../../../lib/session/cloud-session";
import { useAccountWorkspaces } from "../../../components/workspace/workspace-navigation";
import { useT } from "../../../lib/i18n";
import { writeOnboardingDraft } from "../../../lib/session/onboarding-draft";
import { StepFooter, StepHeading } from "../components/step-shell";

/**
 * First step of the rail: the workspace, that is the account's own
 * organization (its name) and the username the bots will use. Once
 * created, the step only renames it.
 *
 * The username belongs to the organization (`operator_profiles`):
 * it is saved AFTER creation, under the new organization, then the
 * page reloads onto the next step. If it is refused, the reload
 * comes back here with the input and the reason for the refusal (kept by the draft).
 *
 * The preview (`normalizeUsername`) is only a PREVIEW: the cloud API rejudges the
 * same rule and stays the only one to decide (`USERNAME_*`).
 */
export function StepWorkspace({
  created,
  workspaceName,
  organizationReset,
  operator,
  pendingUsername,
  pendingUsernameError,
  onBusyChange,
  onAdvance,
}: {
  /** The own organization already exists: one rereads and renames, one does not recreate. */
  created: boolean;
  /** The name the organization already carries, `null` while it does not exist. */
  workspaceName: string | null;
  /** Replay the step after a development reset, even if the organization exists. */
  organizationReset?: boolean;
  /** The username already chosen, `null`/`undefined` otherwise. */
  operator: OperatorProfileDto | null | undefined;
  /** The input kept by the draft when the save failed after creation. */
  pendingUsername: string | null;
  /** This save's refusal, said again after the reload. */
  pendingUsernameError: string | null;
  /** Locks Back and the rail for the duration of the save. */
  onBusyChange?: (busy: boolean) => void;
  onAdvance: () => void;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const account = useAccountWorkspaces();
  const existing = account.data?.workspaces.find((workspace) => workspace.id === activeOrganizationId());
  const [name, setName] = useState(organizationReset ? "" : workspaceName ?? "");
  const [username, setUsername] = useState(operator?.username ?? pendingUsername ?? "");
  // The cloud API's verdict on THIS handle. Cleared at the next keystroke: a
  // message that describes a handle already corrected is a displayed lie.
  const [serverError, setServerError] = useState<string | null>(pendingUsernameError);

  useEffect(() => {
    if (organizationReset || !existing?.name) return;
    setName((currentName) => currentName.trim() ? currentName : existing.name);
  }, [existing?.name, organizationReset]);

  useEffect(() => {
    if (!operator?.username) return;
    setUsername((currentUsername) => currentUsername.trim() ? currentUsername : operator.username);
  }, [operator?.username]);

  const normalized = normalizeUsername(username);
  const problem = usernameProblem(normalized);
  const localError =
    username.trim().length === 0
      ? null
      : problem === "invalid"
        ? t("onboarding.step_workspace.username_invalid_error")
        : problem === "reserved"
          ? t("onboarding.step_workspace.username_reserved_error")
          : null;
  const usernameError = localError ?? serverError;
  const usernameReady = normalized.length > 0 && problem === null;

  const saveUsername = async () => {
    // The PUT is skipped when the handle has not moved: the route is
    // idempotent, but a 409 on one's own handle would be absurd to display.
    if (normalized !== operator?.username) await api.saveOperator({ username: normalized });
  };

  const create = useMutation({
    // `kind` is still required by `POST /api/account/organizations`, and
    // `personal` is the only organization the core creates.
    mutationFn: () => api.createOrganization({ kind: "personal", name: name.trim() }),
    onSuccess: async (organization) => {
      const session = readCloudSession();
      if (session) saveCloudSession({ ...session, organizationId: organization.organizationId });
      // The session now carries the new organization: the username
      // is saved under it. Creating the organization moves the
      // flow forward, without finishing it.
      let refusal: string | null = null;
      try {
        await saveUsername();
      } catch (error) {
        refusal = usernameErrorMessage(error, normalized, t);
      }
      writeOnboardingDraft(refusal === null
        ? { step: "runtime", pendingUsername: null, pendingUsernameError: null }
        : { step: "workspace", pendingUsername: normalized, pendingUsernameError: refusal });
      window.location.replace("/onboarding");
    },
  });

  const update = useMutation({
    mutationFn: async () => {
      const next = name.trim();
      const currentName = existing?.name ?? workspaceName ?? "";
      if (next !== currentName || organizationReset) await api.patchOnboarding({ workspaceName: next });
      try {
        await saveUsername();
      } catch (error) {
        setServerError(usernameErrorMessage(error, normalized, t));
        throw error;
      }
    },
    onSuccess: async () => {
      writeOnboardingDraft({ pendingUsername: null, pendingUsernameError: null });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.onboarding }),
        queryClient.invalidateQueries({ queryKey: queryKeys.roster }),
      ]);
      onAdvance();
    },
  });

  const pending = create.isPending || update.isPending;
  const ready = name.trim().length > 0 && usernameReady && !pending && (created || account.isSuccess);

  useEffect(() => {
    onBusyChange?.(pending);
    // Cleared on unmount: a successful submit moves the flow forward
    // at once, otherwise the shell would stay locked on the next step.
    return () => onBusyChange?.(false);
  }, [pending, onBusyChange]);

  const handleSubmit = () => {
    if (!ready) return;
    setServerError(null);
    if (created) update.mutate();
    else create.mutate();
  };

  const submitOnEnter = (event: React.KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleSubmit();
    }
  };

  const hint = pending
    ? t("onboarding.step_workspace.hint_saving")
    : !name.trim()
      ? t("onboarding.step_workspace.hint_name")
      : !usernameReady
        ? t("onboarding.step_workspace.hint_pick")
        : undefined;

  return (
    <>
      <div className="flex flex-col gap-8 pt-2 sm:pt-6">
        <StepHeading
          title={t("onboarding.step_workspace.headline")}
          description={t("onboarding.step_workspace.lede")}
        />

        {account.error && (
          <p role="alert" className="text-caption text-destructive-text">
            {errorMessage(account.error, t("onboarding.step_workspace.read_failed"))}
          </p>
        )}

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="org-name">{t("onboarding.step_workspace.organization_name")}</FieldLabel>
            <ObInput
              id="org-name"
              autoFocus
              value={name}
              maxLength={80}
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={submitOnEnter}
            />
          </Field>

          <Field data-invalid={usernameError ? true : undefined}>
            <FieldLabel htmlFor="ws-username">
              {t("onboarding.step_workspace.username_label")}
            </FieldLabel>
            <div className="flex items-center rounded-md border bg-muted transition-colors focus-within:border-foreground aria-invalid:border-destructive">
              <span className="select-none pl-3 font-mono text-body text-muted-foreground">
                @
              </span>
              <ObInput
                id="ws-username"
                type="text"
                value={username}
                onChange={(event) => {
                  setUsername(event.target.value);
                  setServerError(null);
                }}
                placeholder={t("onboarding.step_workspace.username_placeholder")}
                className="border-0 bg-transparent font-mono shadow-none focus-visible:ring-0"
                onKeyDown={submitOnEnter}
              />
            </div>
            {usernameError ? <FieldError>{usernameError}</FieldError> : null}
            {/* The preview shows the NORMALIZED handle, not the keystrokes: « Élodie »
                becomes `@elodie`, and that is what the bots will say. */}
            <FieldDescription>
              {normalized.length > 0 && problem === null
                ? t("onboarding.step_workspace.username_description", { username: normalized })
                : t("onboarding.step_workspace.username_pending")}
            </FieldDescription>
          </Field>
        </FieldGroup>

        {(create.error || (update.error && !serverError)) && (
          <p role="alert" className="text-caption text-destructive-text">
            {errorMessage(create.error ?? update.error, t("onboarding.step_workspace.create_organization_failed"))}
          </p>
        )}
      </div>

      <StepFooter hint={hint}>
        <ObButton className="w-full" disabled={!ready} onClick={handleSubmit}>
          {pending
            ? t("onboarding.step_workspace.cta_saving")
            : created ? t("onboarding.common.continue") : t("onboarding.step_workspace.create_organization")}
        </ObButton>
      </StepFooter>
    </>
  );
}

/**
 * The cloud API's verdict, said in our words: by `code`, never by the text
 * of the error: that is the stable contract of the two clients.
 */
function usernameErrorMessage(
  error: unknown,
  username: string,
  t: ReturnType<typeof useT>["t"],
): string {
  if (error instanceof ApiError) {
    if (error.code === "USERNAME_INVALID") return t("onboarding.step_workspace.username_invalid_error");
    if (error.code === "USERNAME_RESERVED") return t("onboarding.step_workspace.username_reserved_error");
    if (error.code === "USERNAME_TAKEN") {
      return t("onboarding.step_workspace.username_taken_error", { username });
    }
  }
  return error instanceof Error && error.message
    ? error.message
    : t("onboarding.step_workspace.create_failed");
}
