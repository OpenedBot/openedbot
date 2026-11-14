import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { ObInput } from "@openedbot/browser-ui-kit/components/onboarding";
import { ApiError, api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { readCloudSession, saveCloudSession } from "../../lib/session/cloud-session";
import { nativeBridge, publicConsoleUrl } from "../../lib/platform";
import { workspaceHref } from "../../lib/workspace/workspace-location";
import { BUTTON } from "../../components/settings/primitives";
import { memberInvitationErrorMessage, roleLabel } from "../../components/settings/member-invitations";
import { StepHeading } from "../onboarding/components/step-shell";
import { Wordmark } from "../onboarding/components/wordmark";

/**
 * `/invite/member/:token`, outside the application frame: anyone holding the
 * link reads who invites them, and the invited address answers.
 *
 * Without an account, the invitee signs up through the ordinary sign-in (an
 * e-mail code to the invited address, which proves it), then comes back here
 * (`?redirect=`). That account gets no workspace of its own: accepting makes
 * it a member of the inviter's, and nothing else.
 */
export function MemberInvitationScreen() {
  const { token } = useParams({ from: "/invite/member/$token" });
  const { t, locale } = useT();
  const [declined, setDeclined] = useState(false);
  const preview = useQuery({ queryKey: ["member-invitation-preview", token], queryFn: () => api.previewMemberInvitation(token), retry: false });
  const session = useQuery({ queryKey: ["member-invitation-session", token], queryFn: api.authStatus, retry: false });
  const invitation = preview.data;
  const signedIn = session.data?.kind === "session";
  const matches = signedIn && session.data?.user?.email.toLowerCase() === invitation?.email.toLowerCase();
  const native = nativeBridge();
  const loginHref = `/login?email=${encodeURIComponent(invitation?.email ?? "")}&redirect=${encodeURIComponent(`/invite/member/${token}`)}`;
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
  const busy = respond.isPending || switchAccount.isPending;
  const error = respond.error ?? switchAccount.error ?? session.error;
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
                {!invitation.hasAccount && <p className="text-sm text-muted-foreground">{t("memberInvitation.signupHelp")}</p>}
                <a className={BUTTON.primary} href={loginHref}>{t(invitation.hasAccount ? "memberInvitation.login" : "memberInvitation.signup")}</a>
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
