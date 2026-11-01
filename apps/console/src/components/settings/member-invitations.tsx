import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { INVITABLE_ROLES, type InvitableRole, type OrganizationMemberInvitationDto } from "@openedbot/contracts-api";
import { Dialog, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, toast, useIsMobile } from "@openedbot/browser-ui-kit";
import { isEmailSyntaxValid, normalizeEmail } from "@openedbot/identity/domain/email-address";
import { ApiError, api, errorMessage, queryKeys } from "../../lib/api";
import { activeOrganizationId } from "../../lib/cloud-session";
import { useT } from "../../lib/i18n";
import { BUTTON, ListRow, ListSection, Note, ToneBadge } from "./primitives";

type InvitationAction = { kind: "send" | "resend" | "cancel"; id?: string; email?: string };

/** Member invitations for the workspace settings screens. */
export function MemberInvitations({
  onMobileActionChange,
}: {
  onMobileActionChange?: (action: ReactNode | null) => void;
}) {
  const { t, locale } = useT();
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const organizationId = activeOrganizationId();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InvitableRole>("member");
  // The same rule as the API (`EMAIL_INVALID`), applied before the request so
  // the field says what is wrong instead of a round trip.
  const [emailProblem, setEmailProblem] = useState<string | null>(null);
  const invitations = useQuery({
    queryKey: queryKeys.organizationInvitations(organizationId ?? "none"),
    queryFn: () => api.organizationInvitations(),
    enabled: Boolean(organizationId),
    refetchInterval: 15_000,
  });
  const action = useMutation({
    mutationFn: async (input: InvitationAction): Promise<void> => {
      if (input.kind === "send") await api.inviteOrganizationMember(normalizeEmail(email), role, locale);
      else if (input.kind === "resend") await api.resendOrganizationInvitation(input.id!);
      else await api.cancelOrganizationInvitation(input.id!);
    },
    onSuccess: async (_result, input) => {
      if (input.kind === "send") {
        setOpen(false);
        setEmail("");
        setRole("member");
      }
      toast.success(t(
        input.kind === "send" ? "memberInvitation.toastSent" : input.kind === "resend" ? "memberInvitation.toastResent" : "memberInvitation.toastCanceled",
        { email: input.email ?? "" },
      ));
      await queryClient.invalidateQueries({ queryKey: queryKeys.organizationMembers(organizationId ?? "none") });
      await invitations.refetch();
    },
    onError: (error) => {
      toast.error(memberInvitationErrorMessage(error, t));
    },
  });
  const submitInvite = () => {
    if (action.isPending) return;
    const candidate = normalizeEmail(email);
    if (!isEmailSyntaxValid(candidate)) {
      setEmailProblem(t("memberInvitation.invalidEmail"));
      return;
    }
    setEmailProblem(null);
    action.mutate({ kind: "send", email: candidate });
  };
  const openInvite = useCallback(() => setOpen(true), []);
  const { reset } = action;

  useEffect(() => {
    if (open) {
      reset();
      setEmailProblem(null);
    }
  }, [open, reset]);

  useEffect(() => {
    const setMobileAction = onMobileActionChange;
    if (!setMobileAction) return;
    if (!isMobile) {
      setMobileAction(null);
      return;
    }
    setMobileAction(
      <button type="button" className={BUTTON.primary} onClick={openInvite}>
        {t("settingsAccount.inviteMember")}
      </button>,
    );
    return () => setMobileAction(null);
  }, [isMobile, onMobileActionChange, openInvite, t]);

  const all = invitations.data?.invitations ?? [];
  const shown = all.filter((invitation) => invitation.status === "pending" || invitation.status === "expired");
  const readError = invitations.error ? memberInvitationErrorMessage(invitations.error, t) : null;
  const actionError = action.error ? memberInvitationErrorMessage(action.error, t) : null;

  return (
    <>
      <ListSection
        title={t("memberInvitation.pendingTitle")}
        description={t("settingsAccount.inviteMemberDescription")}
        action={!isMobile ? (
          <button type="button" className={BUTTON.primary} onClick={openInvite}>
            {t("settingsAccount.inviteMember")}
          </button>
        ) : undefined}
        footer={readError || (actionError && !open) ? <Note tone="danger" role="alert">{readError ?? actionError}</Note> : undefined}
      >
        {invitations.isPending ? <ListRow label={t("memberInvitation.loading")} /> : null}
        {invitations.data && shown.length === 0 ? <ListRow label={t("memberInvitation.empty")} /> : null}
        {shown.map((invitation) => <InvitationRow key={invitation.id} invitation={invitation} locale={locale} busy={action.isPending} onResend={() => action.mutate({ kind: "resend", id: invitation.id, email: invitation.email })} onCancel={() => action.mutate({ kind: "cancel", id: invitation.id, email: invitation.email })} />)}
      </ListSection>

      <Dialog
        open={open}
        onClose={() => { if (!action.isPending) setOpen(false); }}
        title={t("settingsAccount.inviteMemberTitle")}
        description={t("settingsAccount.inviteMemberDescription")}
        closeLabel={t("common.close")}
        footer={(
          <>
            <button type="button" className={BUTTON.secondary} disabled={action.isPending} onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </button>
            <button type="submit" form="member-invite-form" className={BUTTON.primary} disabled={action.isPending || !email.trim()}>
              {action.isPending ? t("common.loading") : t("memberInvitation.send")}
            </button>
          </>
        )}
      >
        <form id="member-invite-form" noValidate className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); submitInvite(); }}>
          <label className="flex flex-col gap-2 text-sm">
            {t("memberInvitation.email")}
            <input
              type="email"
              autoComplete="email"
              required
              maxLength={320}
              value={email}
              aria-invalid={emailProblem !== null}
              aria-describedby={emailProblem ? "member-invite-email-problem" : undefined}
              onChange={(event) => { setEmail(event.target.value); if (emailProblem) setEmailProblem(null); }}
              className="w-full rounded-md border border-border-button-default bg-background-secondary-default p-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <label className="flex flex-col gap-2 text-sm">
            {t("memberInvitation.role")}
            <Select value={role} onValueChange={(value) => { if (INVITABLE_ROLES.includes(value as InvitableRole)) setRole(value as InvitableRole); }}>
              <SelectTrigger className="w-full" aria-label={t("memberInvitation.role")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INVITABLE_ROLES.map((value) => <SelectItem key={value} value={value}>{roleLabel(value, t)}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
          {emailProblem && <p id="member-invite-email-problem" role="alert" className="text-sm text-destructive-text">{emailProblem}</p>}
          {actionError && <p role="alert" className="text-sm text-destructive-text">{actionError}</p>}
        </form>
      </Dialog>
    </>
  );
}

function InvitationRow({
  invitation,
  locale,
  busy,
  onResend,
  onCancel,
}: {
  invitation: OrganizationMemberInvitationDto;
  locale: string;
  busy: boolean;
  onResend: () => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const expired = invitation.status === "expired";
  return (
    <ListRow
      label={invitation.email}
      description={t("memberInvitation.details", {
        role: roleLabel(invitation.role, t),
        date: new Date(invitation.expiresAt).toLocaleDateString(locale),
      })}
      value={<ToneBadge tone={expired ? "neutral" : "warning"}>{t(expired ? "memberInvitation.expired" : "memberInvitation.pending")}</ToneBadge>}
      stacked
    >
      <button type="button" className={BUTTON.small} disabled={busy} onClick={onResend}>
        {t("memberInvitation.resend")}
      </button>
      <button type="button" className={BUTTON.small} disabled={busy} onClick={onCancel}>
        {t("memberInvitation.cancel")}
      </button>
    </ListRow>
  );
}

function roleLabel(role: InvitableRole, t: ReturnType<typeof useT>["t"]): string {
  return role === "admin" ? t("settingsAccount.roleAdmin") : t("settingsAccount.roleMember");
}

function memberInvitationErrorMessage(error: unknown, t: ReturnType<typeof useT>["t"]): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "EMAIL_INVALID": return t("memberInvitation.invalidEmail");
      case "EMAIL_DISPOSABLE": return t("memberInvitation.errorDisposable");
      case "EMAIL_DOMAIN_UNKNOWN": return t("memberInvitation.errorDomainUnknown");
      case "MEMBER_INVITATION_FORBIDDEN": return t("memberInvitation.errorForbidden");
      case "MEMBER_INVITATION_PENDING": return t("memberInvitation.errorPending");
      case "MEMBER_INVITATION_UNAVAILABLE": return t("memberInvitation.errorUnavailable");
      case "MEMBER_INVITATION_EMAIL_MISMATCH": return t("memberInvitation.errorEmailMismatch");
      case "MEMBER_INVITATION_LOGIN_REQUIRED": return t("memberInvitation.errorLoginRequired");
      case "MEMBER_ALREADY": return t("memberInvitation.errorAlready");
      case "MEMBER_QUOTA_REACHED": return t("memberInvitation.errorLimit");
      default: break;
    }
  }
  return errorMessage(error, t("memberInvitation.error"));
}
