import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { ObInput } from "@openedbot/browser-ui-kit/components/onboarding";
import { ApiError, api, errorMessage } from "../../lib/api";
import { useT, type MessageKey } from "../../lib/i18n";
import { readCloudSession, saveCloudSession } from "../../lib/session/cloud-session";
import { nativeBridge, publicConsoleUrl } from "../../lib/platform";
import { workspaceHref } from "../../lib/workspace/workspace-location";
import { BUTTON } from "../../components/settings/primitives";
import { StepHeading } from "../onboarding/components/step-shell";
import { Wordmark } from "../onboarding/components/wordmark";
import type { InvitableRole } from "@openedbot/contracts-api";

export function MemberInvitationScreen() {
  const { token } = useParams({ from: "/invite/member/$token" });
  const { t, locale } = useT();
  const [password, setPassword] = useState("");
  const [declined, setDeclined] = useState(false);
  const preview = useQuery({ queryKey: ["member-invitation-preview", token], queryFn: () => api.previewMemberInvitation(token), retry: false });
  const session = useQuery({ queryKey: ["member-invitation-session", token], queryFn: api.authStatus, retry: false });
  const invitation = preview.data;
  const signedIn = session.data?.kind === "session";
  const matches = signedIn && session.data?.user?.email.toLowerCase() === invitation?.email.toLowerCase();
  const native = nativeBridge();
  const loginHref = `/login?email=${encodeURIComponent(invitation?.email ?? "")}&redirect=${encodeURIComponent(`/invite/member/${token}`)}`;
  const register = useMutation({
    mutationFn: () => api.registerMemberInvitee(token, password),
    onSuccess: async (result) => {
      setPassword("");
      saveCloudSession({ organizationId: null, csrfToken: result.csrfToken, userId: result.user.id });
      await session.refetch();
    },
  });
  const respond = useMutation({
    mutationFn: (accept: boolean) => api.respondToMemberInvitation(token, accept),
    onSuccess: (result) => {
      if (result.status === "declined") {
        setDeclined(true);
        return;
      }
      const current = readCloudSession();
      if (current && result.organizationId) saveCloudSession({ ...current, organizationId: result.organizationId });
      window.location.replace(result.organizationId ? workspaceHref(result.organizationId) : "/");
    },
  });
  const switchAccount = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => { window.location.replace(loginHref); },
  });
  const busy = register.isPending || respond.isPending || switchAccount.isPending;
  const error = register.error ?? respond.error ?? switchAccount.error ?? session.error;
  const invalid = preview.error instanceof ApiError && (preview.error.status === 410 || preview.error.code === "MEMBER_INVITATION_UNAVAILABLE");

  return (
    <main className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto bg-background px-6 pt-[max(2rem,var(--openedbot-safe-top))] pb-[max(2rem,var(--openedbot-safe-bottom))] text-foreground">
      <div className="mx-auto flex w-full max-w-[28rem] flex-col gap-6">
        <Wordmark className="size-8" />
        {declined ? <p role="status">{t("memberInvitation.declined")}</p> : <>
          {preview.isPending && <p role="status">{t("common.loading")}</p>}
          {preview.error && <p role="alert">{invalid ? t("memberInvitation.invalid") : memberInvitationErrorMessage(preview.error, t)}</p>}
          {invitation && <>
            <StepHeading title={t("memberInvitation.title", {
              organizationName: invitation.organizationName,
              role: roleLabel(invitation.role, t),
            })} />
            <label className="flex flex-col gap-2 text-sm">
              {t("memberInvitation.email")}
              <ObInput type="email" readOnly value={invitation.email} autoComplete="email" />
            </label>
            <p className="text-sm text-muted-foreground">{t("memberInvitation.expires", { date: new Date(invitation.expiresAt).toLocaleDateString(locale) })}</p>
            {session.isPending && <p role="status">{t("common.loading")}</p>}
            {!session.isPending && native ? <button
              type="button"
              className={BUTTON.primary}
              onClick={() => void native.openExternal(publicConsoleUrl(`/invite/member/${token}`))}
            >{t("memberInvitation.browser")}</button>
              : !session.isPending && !signedIn && !session.error && <>
                {invitation.hasAccount ? <a className={BUTTON.primary} href={loginHref}>{t("memberInvitation.login")}</a> : <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); if (!busy) register.mutate(); }}>
                  <label className="flex flex-col gap-2 text-sm">
                    {t("memberInvitation.password")}
                    <ObInput type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={12} maxLength={1024} aria-describedby="member-password-help" />
                  </label>
                  <p id="member-password-help" className="text-sm text-muted-foreground">{t("memberInvitation.passwordHelp")}</p>
                  <button type="submit" className={BUTTON.primary} disabled={busy}>{t("memberInvitation.signup")}</button>
                </form>}
              </>}
            {signedIn && !matches && <>
              <p role="alert">{t("memberInvitation.wrongEmail", { email: invitation.email })}</p>
              {!native && <button type="button" className={BUTTON.secondary} disabled={busy} onClick={() => switchAccount.mutate()}>{t("memberInvitation.switchAccount")}</button>}
            </>}
            {matches && !native && <>
              <p>{t("memberInvitation.consent", { organizationName: invitation.organizationName })}</p>
              <div className="flex flex-wrap gap-3">
                <button type="button" className={BUTTON.primary} disabled={busy} onClick={() => respond.mutate(true)}>{t("memberInvitation.accept")}</button>
                <button type="button" className={BUTTON.secondary} disabled={busy} onClick={() => respond.mutate(false)}>{t("memberInvitation.decline")}</button>
              </div>
            </>}
            {busy && <p role="status">{t("common.loading")}</p>}
            {error && <p role="alert" className="text-sm text-destructive-text">{memberInvitationErrorMessage(error, t)}</p>}
          </>}
        </>}
      </div>
    </main>
  );
}

function roleLabel(role: InvitableRole, t: ReturnType<typeof useT>["t"]): string {
  return role === "admin" ? t("settingsAccount.roleAdmin") : t("settingsAccount.roleMember");
}

function memberInvitationErrorMessage(error: unknown, t: ReturnType<typeof useT>["t"]): string {
  if (error instanceof ApiError) {
    const keyByCode: Partial<Record<string, MessageKey>> = {
      MEMBER_INVITATION_FORBIDDEN: "memberInvitation.errorForbidden",
      MEMBER_INVITATION_PENDING: "memberInvitation.errorPending",
      MEMBER_INVITATION_UNAVAILABLE: "memberInvitation.errorUnavailable",
      MEMBER_INVITATION_EMAIL_MISMATCH: "memberInvitation.errorEmailMismatch",
      MEMBER_INVITATION_LOGIN_REQUIRED: "memberInvitation.errorLoginRequired",
      MEMBER_ALREADY: "memberInvitation.errorAlready",
      MEMBER_QUOTA_REACHED: "memberInvitation.errorLimit",
    };
    const key = error.code ? keyByCode[error.code] : undefined;
    if (key) return t(key);
  }
  return errorMessage(error, t("memberInvitation.error"));
}
