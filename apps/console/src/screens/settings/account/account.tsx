import { controlHeight } from "./account-controls";
import { AccountClosureSection } from "./closure";
import { canManageWorkspaceMembers } from "@openedbot/contracts-api";
import { useEffect, useState } from "react";
import { SettingsCardGrid } from "../../../components/settings/settings-card-grid";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconCheck, IconX } from "@tabler/icons-react";
import QRCode from "qrcode";
import { passwordChecks, passwordProblem } from "@openedbot/identity/domain/password";
import type { AssignableRole, OrganizationMemberDto } from "@openedbot/contracts-api";
import { MemberInvitations } from "../../../components/settings/member-invitations";
import { ASSIGNABLE_ROLES } from "@openedbot/contracts-api";
import {
  Dialog,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
  useIsMobile,
} from "@openedbot/browser-ui-kit";
import { ApiError, api, errorMessage, queryKeys } from "../../../lib/api";
import { activeOrganizationId } from "../../../lib/session/cloud-session";
import { useT, type Locale, type MessageKey } from "../../../lib/i18n";
import { hasMessage } from "@openedbot/browser-i18n";
import { isNativeShell } from "../../../lib/platform";
import {
  ACTIONS,
  BUTTON,
  ListRow,
  ListRowsSkeleton,
  ListSection,
  Note,
  SectionHeading,
  ToneBadge,
} from "../../../components/settings/primitives";
import { formatDate } from "../../../lib/format";
import { SettingsPane } from "../pane";
import { PasswordField } from "../journal/security";
import { UsernameRow } from "./profile";

type T = ReturnType<typeof useT>["t"];

/**
 * « Mon compte »: who you are, how you get in, the space where you
 * write, and the people who share it, under a single route.
 *
 * Laid out as a LIST (one section per question, one line per fact, the value or the
 * control on the right) rather than as a grid of cards and tiles: each
 * tile repeated its label in capitals and its icon for a single word of
 * value, and the eye zigzagged between two columns of cards of different
 * heights. The list reads in one stroke, like the reference app's settings.
 *
 * Everything the page says comes from the API: `GET /api/auth/me` (address,
 * space, role), `GET /api/account/security` (Google link, existence of a
 * password), `GET /api/operator` (username),
 * `GET /api/organization/members` (members, `PATCH` / `DELETE /members/:id`).
 *
 * The write gesture on members is guarded by `session.canWrite`: the
 * `member` role reads, assistance mode reads, because the API already refuses
 * (`requireRole`) and a button that leaves as a 403 is a polite lie.
 */
export function AccountSettings() {
  const { t } = useT();
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const session = me.data ?? null;
  const canManage = session?.session.canWrite === true && canManageWorkspaceMembers(session.session.role);
  const assisted = session?.session.impersonation != null;

  // The sections are direct children of the panel: they take its full
  // width (like the reference app's settings) and its spacing, on desktop as well as
  // on the phone. A capped column left a gap on the right of the modal.
  return (
    <SettingsPane>
      <SectionHeading
        title={t("settingsAccount.title")}
        description={t("settingsAccount.description")}
      />
      {assisted ? <Note tone="warning">{t("settingsAccount.assistance")}</Note> : null}
      <SettingsCardGrid>
        <ProfileSection />
        <ConnectionSection />
        {isNativeShell() ? null : <MobileSection />}
        <WorkspaceSection />
      </SettingsCardGrid>
      <MembersCard canManage={canManage} viewerEmail={session?.user.email ?? null} />
      {canManage && !assisted ? <MemberInvitations /> : null}
      {!assisted ? <AccountClosureSection /> : null}
    </SettingsPane>
  );
}

/** A section's read-failure note, with the API's message when there is one. */
function ReadError({ error }: { error: unknown }) {
  const { t } = useT();
  return (
    <Note tone="danger" role="alert">
      {error instanceof Error ? error.message : t("settingsAccount.readError")}
    </Note>
  );
}

/**
 * Profile: the display name (served by the sign-in provider, read) and the
 * username (the only field the page writes).
 */
function ProfileSection() {
  const { t } = useT();
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const user = me.data?.user;
  return (
    <ListSection
      title={t("settingsAccount.profileTitle")}
      footer={me.error ? <ReadError error={me.error} /> : undefined}
    >
      {me.isPending ? (
        <ListRowsSkeleton label={t("settingsAccount.loading")} rows={2} />
      ) : (
        <>
          {user ? (
            <ListRow
              label={t("settingsAccount.displayNameLabel")}
              description={t("settingsAccount.displayNameHint")}
              value={user.displayName ?? t("settingsAccount.displayNameUnset")}
            />
          ) : null}
          <UsernameRow />
        </>
      )}
    </ListSection>
  );
}

/**
 * Sign-in: the address, the Google link, and whether a password exists.
 *
 * The last two are FACTS served by `GET /api/account/security`:
 * never deduced from the address ("it ends in gmail.com, therefore SSO") nor from
 * the fact that one entered through Google this time. Google links here (a
 * Google account of the same address) and unlinks only if a password remains,
 * otherwise the account would have no way in. The password changes
 * only if one exists: the API requires the current one (`PASSWORD_NOT_SET` otherwise).
 */
function ConnectionSection() {
  const { t } = useT();
  const [changing, setChanging] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const security = useQuery({ queryKey: queryKeys.accountSecurity, queryFn: api.accountSecurity });
  const providers = useQuery({ queryKey: queryKeys.authProviders, queryFn: api.authProviders });
  const method = security.data?.method;
  const error = me.error ?? security.error;
  const link = useGoogleLink(method?.email ?? "");
  const googleProvider = providers.data?.google;
  const googleDisabledReason = googleProvider && !googleProvider.enabled
    ? t(googleProvider.reason === "origin_unsupported"
      ? "login.googleDisabledOriginUnsupported"
      : "login.googleDisabledNotConfigured")
    : null;

  return (
    <>
      <ListSection
        title={t("settingsAccount.connectionTitle")}
        footer={error ? <ReadError error={error} /> : link.note ? (
          <Note tone={link.note.tone} role={link.note.tone === "danger" ? "alert" : "status"}>{link.note.text}</Note>
        ) : undefined}
      >
        {me.isPending || security.isPending ? (
          <ListRowsSkeleton label={t("settingsAccount.loading")} rows={3} />
        ) : (
          <>
            {me.data ? (
              <ListRow
                label={t("settingsAccount.emailLabel")}
                description={t("settingsAccount.emailHint")}
                value={me.data.user.email}
              />
            ) : null}
            {method ? (
              <>
                <ListRow
                  label={t("settingsAccount.googleLabel")}
                  description={
                    link.waiting
                      ? t("settingsAccount.googleWaitingHint")
                      : method.google && !method.password
                        ? t("settingsAccount.googleUnlinkNeedsPassword")
                        : !method.google && googleDisabledReason
                          ? googleDisabledReason
                          : t("settingsAccount.googleHint")
                  }
                >
                  <ToneBadge tone={method.google ? "success" : "neutral"}>
                    {t(method.google ? "settingsAccount.googleLinked" : "settingsAccount.googleUnlinked")}
                  </ToneBadge>
                  {method.google ? (
                    // Unlinking without a password would leave the account with no
                    // way in: the button stays visible but grayed, the line says
                    // why. The API refuses the same way (`GOOGLE_UNLINK_NEEDS_PASSWORD`).
                    <button
                      type="button"
                      className={BUTTON.danger}
                      aria-label={t("settingsAccount.googleDisconnectLabel")}
                      disabled={!method.password}
                      onClick={() => {
                        link.clearNote();
                        setUnlinking(true);
                      }}
                    >
                      {t("settingsAccount.googleDisconnect")}
                    </button>
                  ) : link.waiting ? (
                    <button type="button" className={BUTTON.secondary} onClick={link.cancel}>
                      {t("settingsAccount.googleCancel")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={BUTTON.soft}
                      aria-label={t("settingsAccount.googleConnectLabel")}
                      disabled={googleDisabledReason !== null || link.starting}
                      onClick={link.start}
                    >
                      {t("settingsAccount.googleConnect")}
                    </button>
                  )}
                </ListRow>
                <ListRow
                  label={t("settingsAccount.passwordLabel")}
                  description={t(method.password ? "settingsAccount.passwordHint" : "settingsAccount.passwordSsoOnly")}
                >
                  <ToneBadge tone={method.password ? "success" : "neutral"}>
                    {t(method.password ? "settingsAccount.passwordSet" : "settingsAccount.passwordUnset")}
                  </ToneBadge>
                  {method.password ? (
                    <button
                      type="button"
                      className={BUTTON.secondary}
                      aria-label={t("settingsAccount.passwordChange")}
                      onClick={() => setChanging(true)}
                    >
                      {t("settingsAccount.passwordChangeShort")}
                    </button>
                  ) : null}
                </ListRow>
              </>
            ) : null}
          </>
        )}
      </ListSection>
      {/* Outside the section's `<ul>`: the dialog is not a line. */}
      <PasswordDialog open={changing} onClose={() => setChanging(false)} />
      <GoogleUnlinkDialog
        open={unlinking}
        onClose={() => setUnlinking(false)}
        onUnlinked={() => {
          setUnlinking(false);
          link.announce({ tone: "success", text: t("settingsAccount.googleUnlinkedDone") });
        }}
      />
    </>
  );
}

/** Same pace and same patience as the native shell's Google claim. */
const GOOGLE_LINK_POLL_MS = 1_500;
const GOOGLE_LINK_TIMEOUT_MS = 5 * 60_000;

type LinkNote = { tone: "success" | "danger"; text: string };

/**
 * Link Google: the attempt is created by the API for the signed-in user,
 * Google opens OUTSIDE the window (Google refuses webviews), and the page
 * polls `google/link/claim` until the outcome. No session changes: the
 * Google callback only sets `google_subject` on this account.
 */
function useGoogleLink(email: string) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [note, setNote] = useState<LinkNote | null>(null);

  const start = useMutation({ mutationFn: api.googleLinkStart });

  useEffect(() => {
    if (!attemptId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + GOOGLE_LINK_TIMEOUT_MS;
    const finish = (next: LinkNote) => {
      stopped = true;
      setAttemptId(null);
      setNote(next);
    };
    const poll = async () => {
      if (stopped) return;
      if (Date.now() > deadline) {
        finish({ tone: "danger", text: t("settingsAccount.googleTimeout") });
        return;
      }
      try {
        const claim = await api.googleLinkClaim(attemptId);
        if (stopped) return;
        if (claim.status === "done") {
          void queryClient.invalidateQueries({ queryKey: queryKeys.accountSecurity });
          finish({ tone: "success", text: t("settingsAccount.googleLinkedDone") });
          return;
        }
        if (claim.status === "failed") {
          finish({ tone: "danger", text: googleLinkFailure(claim.code, email, t) });
          return;
        }
      } catch {
        // A lost probe (network, API restart) is not an outcome:
        // the next one will say where the attempt stands, until the deadline.
      }
      if (!stopped) timer = setTimeout(() => void poll(), GOOGLE_LINK_POLL_MS);
    };
    timer = setTimeout(() => void poll(), GOOGLE_LINK_POLL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [attemptId, email, queryClient, t]);

  return {
    waiting: attemptId !== null,
    starting: start.isPending,
    note,
    clearNote: () => setNote(null),
    announce: (next: LinkNote) => setNote(next),
    cancel: () => setAttemptId(null),
    start: () => {
      setNote(null);
      // On the web, the tab opens INSIDE the click, before the API's response:
      // opened after an `await`, the browser blocks it as a
      // popup. In the shell, `window.open` goes to the system browser
      // and always returns `null`: one
      // therefore opens the Google URL itself, once it is known.
      const native = isNativeShell();
      const tab = native ? null : globalThis.window?.open("", "_blank") ?? null;
      if (tab) {
        try { tab.opener = null; } catch { /* already isolated */ }
      }
      start.mutate(undefined, {
        onSuccess: (started) => {
          if (native) {
            globalThis.window?.open(started.authorizeUrl, "_blank");
          } else if (tab) {
            tab.location.href = started.authorizeUrl;
          } else {
            setNote({ tone: "danger", text: t("settingsAccount.googlePopupBlocked") });
            return;
          }
          setAttemptId(started.attemptId);
        },
        onError: (error) => {
          tab?.close();
          setNote({ tone: "danger", text: errorMessage(error, t("settingsSecurity.errorGeneric")) });
        },
      });
    },
  };
}

function googleLinkFailure(code: string, email: string, t: T): string {
  if (code === "GOOGLE_EMAIL_MISMATCH") return t("settingsAccount.googleErrorEmailMismatch", { email });
  if (code === "GOOGLE_ALREADY_LINKED") return t("settingsAccount.googleErrorAlreadyLinked");
  const key = `login.failed.${code}`;
  return t(hasMessage(key) ? (key as MessageKey) : "login.failed.UNKNOWN");
}

/**
 * Unlink Google: the current password is required (the same proof as for
 * changing it), and the other devices are signed out.
 */
function GoogleUnlinkDialog({
  open,
  onClose,
  onUnlinked,
}: {
  open: boolean;
  onClose: () => void;
  onUnlinked: () => void;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState("");
  const [shown, setShown] = useState(false);

  const unlink = useMutation({
    mutationFn: () => api.googleUnlink(current),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.accountSecurity });
      setCurrent("");
      setShown(false);
      unlink.reset();
      onUnlinked();
    },
  });

  // Closing EMPTIES the modal, like `PasswordDialog`, and inside the handler.
  const close = () => {
    setCurrent("");
    setShown(false);
    unlink.reset();
    onClose();
  };

  const canSubmit = current.length > 0 && !unlink.isPending;

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t("settingsAccount.googleUnlinkTitle")}
      description={t("settingsAccount.googleUnlinkDescription")}
      closeLabel={t("settingsAccount.removeCancel")}
      className="max-w-lg"
      footer={
        <div className={ACTIONS}>
          <button type="button" className={BUTTON.secondary} onClick={close}>
            {t("settingsAccount.removeCancel")}
          </button>
          <button type="submit" form="account-google-unlink-form" className={BUTTON.danger} disabled={!canSubmit}>
            {unlink.isPending ? t("settingsAccount.googleUnlinking") : t("settingsAccount.googleUnlinkConfirm")}
          </button>
        </div>
      }
    >
      <form
        id="account-google-unlink-form"
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) unlink.mutate();
        }}
      >
        <PasswordField
          id="account-google-unlink-password"
          label={t("settingsSecurity.currentPasswordLabel")}
          autoComplete="current-password"
          value={current}
          shown={shown}
          onChange={setCurrent}
          onToggleShown={() => setShown((value) => !value)}
          t={t}
        />
      </form>
      {unlink.error ? (
        <div className="mt-3">
          <Note tone="danger" role="alert">{googleUnlinkErrorMessage(unlink.error, t)}</Note>
        </div>
      ) : null}
    </Dialog>
  );
}

function googleUnlinkErrorMessage(error: unknown, t: T): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "CREDENTIALS_INVALID": return t("settingsSecurity.errorCredentialsInvalid");
      case "GOOGLE_UNLINK_NEEDS_PASSWORD": return t("settingsAccount.googleUnlinkNeedsPassword");
      case "GOOGLE_NOT_LINKED": return t("settingsAccount.googleErrorNotLinked");
      default: break;
    }
  }
  return error instanceof Error ? error.message : t("settingsSecurity.errorGeneric");
}

/**
 * Mobile application (Mobile Connect): a QR that opens a session on the iPhone without
 * retyping the password. The ticket (`POST /api/auth/mobile-connect/tickets`) is worth ten
 * minutes and serves only once; the app trades it for a native code bound to its PKCE.
 * Hidden in the native shell: one does not scan a QR with the phone that displays it.
 */
function MobileSection() {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <ListSection title={t("settingsAccount.mobileTitle")}>
        <ListRow label={t("settingsAccount.mobileTitle")} description={t("settingsAccount.mobileDescription")}>
          <button type="button" className={BUTTON.soft} onClick={() => setOpen(true)}>
            {t("settingsAccount.mobileShow")}
          </button>
        </ListRow>
      </ListSection>
      {/* Outside the section's `<ul>`: the dialog is not a line. */}
      <MobileConnectDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function MobileConnectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, locale } = useT();
  const [qr, setQr] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [copied, setCopied] = useState(false);
  const ticket = useMutation({ mutationFn: api.mobileConnectTicket });
  const create = ticket.mutate;
  const link = ticket.data?.url ?? null;
  const expiresAt = ticket.data?.expiresAt ?? null;

  // Opening asks for a ticket; closing forgets it (it stays valid on the API side until its
  // expiry, but nothing here replays it).
  useEffect(() => {
    if (open) {
      create();
    } else {
      ticket.reset();
      setQr(null);
      setExpired(false);
      setCopied(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `ticket.reset` is stable
  }, [open, create]);

  useEffect(() => {
    if (!link) return;
    let cancelled = false;
    QRCode.toDataURL(link, { margin: 1, width: 240, errorCorrectionLevel: "M" })
      .then((dataUrl) => { if (!cancelled) setQr(dataUrl); })
      .catch(() => { if (!cancelled) setQr(null); });
    return () => { cancelled = true; };
  }, [link]);

  useEffect(() => {
    if (!expiresAt) return;
    setExpired(false);
    const remaining = new Date(expiresAt).getTime() - Date.now();
    if (remaining <= 0) { setExpired(true); return; }
    const timer = window.setTimeout(() => setExpired(true), remaining);
    return () => window.clearTimeout(timer);
  }, [expiresAt]);

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // Clipboard refused (insecure context): the link stays selectable.
      setCopied(false);
    }
  };

  const expiresLabel = expiresAt
    ? new Date(expiresAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
    : "";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("settingsAccount.mobileDialogTitle")}
      description={t("settingsAccount.mobileDialogDescription")}
      closeLabel={t("settingsAccount.mobileClose")}
      className="max-w-md"
      footer={
        <div className={ACTIONS}>
          <button type="button" className={BUTTON.secondary} onClick={onClose}>
            {t("settingsAccount.mobileClose")}
          </button>
          <button type="button" className={BUTTON.soft} disabled={ticket.isPending} onClick={() => create()}>
            {ticket.isPending ? t("settingsAccount.mobileCreating") : t("settingsAccount.mobileRenew")}
          </button>
        </div>
      }
    >
      <div className="flex flex-col items-center gap-3">
        {ticket.isError ? (
          <Note tone="danger" role="alert">{t("settingsAccount.mobileError")}</Note>
        ) : qr && !expired ? (
          <img src={qr} alt={t("settingsAccount.mobileDialogTitle")} width={240} height={240} className="rounded-md bg-white p-2" />
        ) : (
          <div className="flex h-60 w-60 items-center justify-center rounded-md bg-muted text-sm text-muted-foreground" role="status">
            {expired ? t("settingsAccount.mobileExpired") : t("settingsAccount.mobileCreating")}
          </div>
        )}
        {link && !expired ? (
          <>
            <p className="text-xs text-muted-foreground">{t("settingsAccount.mobileExpires", { time: expiresLabel })}</p>
            <div className="w-full">
              <p className="text-sm font-medium">{t("settingsAccount.mobileLinkLabel")}</p>
              <p className="text-xs text-muted-foreground">{t("settingsAccount.mobileLinkHint")}</p>
              <code className="mt-1 block w-full select-all overflow-x-auto rounded-md border border-border bg-muted px-2 py-1 text-xs">{link}</code>
              <div className={cn(ACTIONS, "mt-2")}>
                <button type="button" className={BUTTON.secondary} onClick={() => void copy()}>
                  {copied ? t("settingsAccount.mobileCopied") : t("settingsAccount.mobileCopy")}
                </button>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}

/** The space where the session writes, and what it can do there: read, never editable here. */
function WorkspaceSection() {
  const { t } = useT();
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  return (
    <ListSection
      title={t("settingsAccount.workspaceTitle")}
      footer={me.error ? <ReadError error={me.error} /> : undefined}
    >
      {me.isPending ? <ListRowsSkeleton label={t("settingsAccount.loading")} rows={3} /> : null}
      {me.data ? (
        <>
          <ListRow
            label={t("settingsAccount.organizationLabel")}
            description={t("settingsAccount.organizationHint")}
            value={me.data.organization.name}
          />
          <ListRow
            label={t("settingsAccount.organizationSlugLabel")}
            description={t("settingsAccount.organizationSlugHint")}
            value={me.data.organization.slug}
            mono
          />
          <ListRow label={t("settingsAccount.roleLabel")} description={t("settingsAccount.roleHint")}>
            <RoleBadge role={me.data.session.role} />
          </ListRow>
        </>
      ) : null}
    </ListSection>
  );
}

/**
 * The password change, in a modal.
 *
 * The shape rule is SHARED with the API (`passwordProblem`): it
 * disables the button before sending, and the API re-judges the same rule and remains
 * the only one to decide. `passwordChecks` breaks it down so the list stays live
 * during typing: saying « trop faible » after the fact teaches nothing.
 */
function PasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [currentShown, setCurrentShown] = useState(false);
  const [nextShown, setNextShown] = useState(false);
  const [confirmShown, setConfirmShown] = useState(false);

  const change = useMutation({
    mutationFn: () => api.changePassword({ currentPassword: current, newPassword: next }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.accountSecurity }),
  });

  /**
   * Closing EMPTIES the modal: a password left in a field is both
   * a surprise on reopen and a shoulder-surf leak.
   *
   * In the handler, never in an effect: `useMutation` returns a new object
   * on every render, and an effect that calls `reset()` with that object as a
   * dependency loops until « Maximum update depth exceeded ».
   */
  const close = () => {
    setCurrent("");
    setNext("");
    setConfirm("");
    setCurrentShown(false);
    setNextShown(false);
    setConfirmShown(false);
    change.reset();
    onClose();
  };

  const checks = passwordChecks(next);
  const problem = passwordProblem(next, current);
  const mismatch = confirm.length > 0 && confirm !== next;
  const canSubmit =
    problem === null && !mismatch && current.length > 0 && confirm.length > 0 && !change.isPending;

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t("settingsAccount.passwordChange")}
      description={t("settingsAccount.passwordDialogDescription")}
      closeLabel={t("settingsAccount.removeCancel")}
      className="max-w-lg"
      footer={
        <div className={ACTIONS}>
          <button type="button" className={BUTTON.secondary} onClick={close}>
            {t("settingsAccount.removeCancel")}
          </button>
          <button
            type="submit"
            form="account-password-form"
            className={BUTTON.primary}
            disabled={!canSubmit}
          >
            {change.isPending
              ? t("settingsSecurity.passwordSubmitting")
              : t("settingsSecurity.passwordSubmit")}
          </button>
        </div>
      }
    >
      <form
        id="account-password-form"
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) change.mutate();
        }}
      >
        <PasswordField
          id="account-current-password"
          label={t("settingsSecurity.currentPasswordLabel")}
          autoComplete="current-password"
          value={current}
          shown={currentShown}
          onChange={setCurrent}
          onToggleShown={() => setCurrentShown((shown) => !shown)}
          t={t}
        />
        <PasswordField
          id="account-new-password"
          label={t("settingsSecurity.newPasswordLabel")}
          autoComplete="new-password"
          describedBy="account-password-rules"
          value={next}
          shown={nextShown}
          onChange={setNext}
          onToggleShown={() => setNextShown((shown) => !shown)}
          t={t}
        />
        <PasswordField
          id="account-confirm-password"
          label={t("settingsSecurity.confirmPasswordLabel")}
          autoComplete="new-password"
          value={confirm}
          shown={confirmShown}
          onChange={setConfirm}
          onToggleShown={() => setConfirmShown((shown) => !shown)}
          t={t}
        />
        {/*
          The requirements list is the LIVE feedback of typing: each
          rule is true or false on every character, never after sending.
          `aria-live="polite"` makes it exist also for whoever does not see the
          color, and `aria-describedby` attaches it to the field it judges.
        */}
        <ul
          id="account-password-rules"
          aria-live="polite"
          className="space-y-1.5 rounded-lg bg-surface-sunken px-3 py-2.5"
        >
          <PasswordRule ok={checks.length} label={t("settingsAccount.ruleLength")} />
          <PasswordRule ok={checks.uppercase} label={t("settingsAccount.ruleUppercase")} />
          <PasswordRule ok={checks.symbol} label={t("settingsAccount.ruleSymbol")} />
          <PasswordRule
            ok={confirm.length > 0 && confirm === next}
            label={t("settingsAccount.ruleConfirm")}
          />
        </ul>
      </form>
      <div className="mt-3 space-y-2 empty:mt-0">
        {change.isSuccess ? (
          <Note tone="success" role="status">
            {t("settingsSecurity.passwordSuccess", { count: change.data.revokedOtherSessions })}
          </Note>
        ) : null}
        {change.error ? (
          <Note tone="danger" role="alert">{passwordErrorMessage(change.error, t)}</Note>
        ) : null}
      </div>
    </Dialog>
  );
}

/**
 * One requirement, and whether the typing in progress satisfies it.
 *
 * The pill FILLS when the rule passes; it does not only change
 * glyph: a gray cross that becomes a 12 px green check is missed from the
 * corner of the eye, and the screen gave the impression of a dead list. The label
 * carries `data-ok`: that is what the tests read, not a class.
 */
function PasswordRule({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2 text-xs">
      <span
        aria-hidden
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
          ok
            ? "border-pos-700 bg-pos-700 text-white"
            : "border-border bg-transparent text-muted-foreground",
        )}
      >
        {ok ? <IconCheck className="size-3" /> : <IconX className="size-3" />}
      </span>
      <span
        data-ok={ok ? "" : undefined}
        className={cn("transition-colors", ok ? "font-medium text-pos-700" : "text-muted-foreground")}
      >
        {label}
      </span>
      <span className="sr-only">{ok ? "✓" : "✗"}</span>
    </li>
  );
}

function passwordErrorMessage(error: unknown, t: T): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "PASSWORD_NOT_SET": return t("settingsSecurity.errorPasswordNotSet");
      case "CREDENTIALS_INVALID": return t("settingsSecurity.errorCredentialsInvalid");
      case "PASSWORD_TOO_WEAK": return t("settingsSecurity.errorPasswordTooWeak");
      case "PASSWORD_UNCHANGED": return t("settingsSecurity.errorPasswordUnchanged");
      default: break;
    }
  }
  return error instanceof Error ? error.message : t("settingsSecurity.errorGeneric");
}

/** The role, said in one word and colored by its power: owner carries the space. */
function RoleBadge({ role }: { role: string }) {
  const { t } = useT();
  const tone = role === "owner" ? "info" : role === "admin" ? "success" : "neutral";
  return <ToneBadge tone={tone}>{roleLabel(role, t)}</ToneBadge>;
}

function roleLabel(role: string, t: T): string {
  if (role === "owner") return t("settingsAccount.roleOwner");
  if (role === "admin") return t("settingsAccount.roleAdmin");
  return t("settingsAccount.roleMember");
}

function isAssignableRole(value: string): value is AssignableRole {
  return value === "admin" || value === "member";
}

/**
 * The members, with their two writes: the role and the removal.
 *
 * The owner is rendered inert rather than absent: `assertMutableMemberRole`
 * protects them on the API side, and hiding them would suggest the space has no
 * owner. Oneself is not removable: one does not remove oneself from a space
 * from the screen that manages it, one signs out of it.
 */
function MembersCard({ canManage, viewerEmail }: { canManage: boolean; viewerEmail: string | null }) {
  const { t, locale, plural } = useT();
  const queryClient = useQueryClient();
  const organizationId = activeOrganizationId();
  const members = useQuery({
    queryKey: queryKeys.organizationMembers(organizationId ?? "none"),
    queryFn: () => api.organizationMembers(),
    enabled: Boolean(organizationId),
  });
  const [pendingRemoval, setPendingRemoval] = useState<OrganizationMemberDto | null>(null);

  const refresh = () => queryClient.invalidateQueries({
    queryKey: queryKeys.organizationMembers(organizationId ?? "none"),
  });

  const setRole = useMutation({
    mutationFn: (input: { userId: string; role: AssignableRole }) =>
      api.setOrgMemberRole(input.userId, input.role),
    onSuccess: () => void refresh(),
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api.removeOrgMember(userId),
    onSuccess: () => {
      setPendingRemoval(null);
      void refresh();
    },
  });

  const rows = members.data?.members ?? [];
  const count = rows.length;

  const notes = [
    members.error ? (
      <Note key="read" tone="danger" role="alert">
        {members.error instanceof Error ? members.error.message : t("settingsAccount.membersReadError")}
      </Note>
    ) : null,
    !canManage && count > 0 ? <Note key="readOnly" tone="neutral">{t("settingsAccount.readOnly")}</Note> : null,
    setRole.error ? <Note key="role" tone="danger" role="alert">{memberErrorMessage(setRole.error, t)}</Note> : null,
    remove.error ? <Note key="remove" tone="danger" role="alert">{memberErrorMessage(remove.error, t)}</Note> : null,
  ].filter(Boolean);

  return (
    <>
      <ListSection
        title={t("settingsAccount.membersTitle")}
        description={t("settingsAccount.membersDescription")}
        action={
          members.data ? (
            <ToneBadge tone="neutral">
              {plural(count, {
                one: t("settingsAccount.membersCountOne"),
                other: t("settingsAccount.membersCountOther"),
              })}
            </ToneBadge>
          ) : undefined
        }
        footer={notes.length > 0 ? notes : undefined}
      >
        {/* `isLoading` and not `isPending`: without an active organization the query
            stays disabled (therefore `pending` forever), and an eternal skeleton
            would lie. */}
        {members.isLoading ? <ListRowsSkeleton label={t("settingsAccount.membersLoading")} /> : null}
        {members.data && count === 0 ? (
          <ListRow label={t("settingsAccount.membersEmpty")} />
        ) : null}
        {rows.map((member) => (
          <MemberRow
            key={member.userId}
            member={member}
            isViewer={viewerEmail !== null && member.email.toLowerCase() === viewerEmail.toLowerCase()}
            canManage={canManage}
            busy={setRole.isPending && setRole.variables?.userId === member.userId}
            locale={locale}
            onRole={(role) => setRole.mutate({ userId: member.userId, role })}
            onRemove={() => setPendingRemoval(member)}
          />
        ))}
      </ListSection>

      <Dialog
        open={pendingRemoval !== null}
        onClose={() => setPendingRemoval(null)}
        title={t("settingsAccount.removeTitle")}
        description={t("settingsAccount.removeDescription", {
          member: pendingRemoval ? memberName(pendingRemoval) : "",
        })}
        closeLabel={t("settingsAccount.removeCancel")}
        footer={
          <div className={ACTIONS}>
            <button type="button" className={BUTTON.secondary} onClick={() => setPendingRemoval(null)}>
              {t("settingsAccount.removeCancel")}
            </button>
            <button
              type="button"
              className={BUTTON.danger}
              disabled={remove.isPending}
              onClick={() => { if (pendingRemoval) remove.mutate(pendingRemoval.userId); }}
            >
              {remove.isPending ? t("settingsAccount.memberRemoving") : t("settingsAccount.removeConfirm")}
            </button>
          </div>
        }
      >
        {null}
      </Dialog>
    </>
  );
}

function memberName(member: OrganizationMemberDto): string {
  return member.displayName?.trim() || member.email;
}

function MemberRow({
  member,
  isViewer,
  canManage,
  busy,
  locale,
  onRole,
  onRemove,
}: {
  member: OrganizationMemberDto;
  isViewer: boolean;
  canManage: boolean;
  busy: boolean;
  locale: Locale;
  onRole: (role: AssignableRole) => void;
  onRemove: () => void;
}) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const viewer = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const name = memberName(member);
  const isOwner = member.role === "owner";
  // The owner is protected by the API (`assertMutableMemberRole`), and one does not
  // remove oneself: both controls close rather than fail.
  const editable = canManage && !isOwner && viewer.data !== undefined;

  return (
    <ListRow
      stacked={editable}
      label={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{name}</span>
          {isViewer ? <ToneBadge tone="info">{t("settingsAccount.memberYou")}</ToneBadge> : null}
        </span>
      }
      description={
        <span className="block truncate">
          {member.displayName?.trim() ? `${member.email} · ` : ""}
          {t("settingsAccount.memberJoined", { date: formatDate(member.createdAt, locale) })}
        </span>
      }
    >
      {editable ? (
        <Select
          value={member.role}
          onValueChange={(role) => { if (isAssignableRole(role)) onRole(role); }}
          disabled={busy}
        >
          <SelectTrigger
            className={cn(controlHeight(isMobile), !isMobile && "w-36")}
            aria-label={t("settingsAccount.memberRoleAria", { member: name })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ASSIGNABLE_ROLES.map((role) => (
              <SelectItem key={role} value={role}>{roleLabel(role, t)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <RoleBadge role={member.role} />
      )}
      {editable && !isViewer ? (
        <button type="button" className={cn(BUTTON.danger, controlHeight(isMobile))} onClick={onRemove}>
          {t("settingsAccount.memberRemove")}
        </button>
      ) : null}
    </ListRow>
  );
}

/**
 * The API's verdict, said in our words: by `code`, never by the error's
 * text: that is the stable contract, and the server message stays the fallback
 * for what this file does not know yet.
 */
function memberErrorMessage(error: unknown, t: T): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "OWNER_ROLE_PROTECTED": return t("settingsAccount.errorOwnerProtected");
      case "MEMBER_SUBMISSION_IN_PROGRESS": return t("settingsAccount.errorMemberBusy");
      case "ROLE_INVALID": return t("settingsAccount.errorRole");
      default: break;
    }
  }
  return error instanceof Error ? error.message : t("settingsAccount.readError");
}
