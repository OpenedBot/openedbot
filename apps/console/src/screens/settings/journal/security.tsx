import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconClock,
  IconDeviceLaptop,
  IconDevices,
  IconEye,
  IconEyeOff,
  IconHistory,
  IconKey,
  IconMail,
  IconShieldLock,
  IconWorld,
} from "@tabler/icons-react";
import { passwordProblem } from "@openedbot/identity/domain/password";
import type { AccountAuthMethodDto, AccountSessionDto } from "@openedbot/contracts-api";
import { Dialog, Tabs, TabsContent, TabsList, TabsTrigger, useIsMobile } from "@openedbot/browser-ui-kit";
import { ApiError, api, queryKeys } from "../../../lib/api";
import { useSignOut } from "../../../lib/session/sign-out";
import { resetAuthStatus } from "../../../lib/session/auth-status";
import { useT } from "../../../lib/i18n";
import {
  ACTIONS,
  BUTTON,
  CardHeading,
  CardSkeleton,
  FIELD,
  Note,
  ListRow,
  ListSection,
  SectionHeading,
  SettingsCard,
  StatusGrid,
  StatusTile,
  ToneBadge,
} from "../../../components/settings/primitives";
import { formatDate } from "../../../lib/format";
import { SettingsPane } from "../pane";
import { DevicesList, DevicesTable, describeDevice, isActiveSession } from "./devices-table";

/** Stable reference for the "not yet loaded" state: see `others` below. */
const EMPTY_SESSIONS: AccountSessionDto[] = [];

/**
 * Account security: `/api/account/security`, extracted from `cloud.tsx`
 * (`CloudSecuritySettings`, name kept) and finally translated.
 *
 * Three surfaces: the current session, the sign-in method (Google /
 * password / both: never guessed, always what the API returns),
 * and the other signed-in devices with their individual or
 * grouped revocation. The password form mounts only if the account has
 * one (`method.password`); otherwise a note says why it is absent: an
 * SSO-only account has nothing to change here (plan B.6: no « définir un
 * mot de passe » without the current password, that would require an email
 * confirmation that no sender in the repository knows how to send).
 */
export function CloudSecuritySettings({ sessionsOnly = false }: { sessionsOnly?: boolean } = {}) {
  const { t, locale } = useT();
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();

  const state = useQuery({ queryKey: queryKeys.accountSecurity, queryFn: api.accountSecurity });
  const data = state.data ?? null;
  // `sessions` keeps the cached data's reference: `DevicesTable` passes
  // this array to TanStack Table, which treats a new reference as
  // new data and re-renders in a loop. A bare `.filter()` on every render
  // was enough to start the loop: hence the shared empty constant.
  const sessions = data?.sessions ?? EMPTY_SESSIONS;
  const current = sessions.find((session) => session.current) ?? null;
  // The tab badge and the « Déconnecter les autres » button count the
  // OTHER sessions still alive. Revoked ones stay in the table:
  // that is the history: but announcing « Appareils 6 » when two are already
  // cut off was a lie by omission; counting the current one would be
  // another, one does not « déconnecte » oneself with this button.
  const activeOthers = useMemo(
    () => sessions.filter((session) => !session.current && isActiveSession(session)),
    [sessions],
  );
  const others = useMemo(() => sessions.filter((session) => !session.current), [sessions]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.accountSecurity });

  const logout = useSignOut();

  const revokeSession = useMutation({
    mutationFn: (sessionId: string) => api.revokeSession(sessionId),
    onSuccess: () => void invalidate(),
  });

  const [confirmingRevokeOthers, setConfirmingRevokeOthers] = useState(false);
  const revokeOthers = useMutation({
    mutationFn: () => api.revokeOtherSessions(),
    onSuccess: () => {
      setConfirmingRevokeOthers(false);
      void invalidate();
    },
  });

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [currentShown, setCurrentShown] = useState(false);
  const [newShown, setNewShown] = useState(false);
  const [confirmShown, setConfirmShown] = useState(false);

  // The shape rule is SHARED with the API (`passwordProblem`): it
  // disables the button before the request is even sent, but the API re-judges
  // the same rule and remains the only one to decide.
  const problem = passwordProblem(newPassword, currentPassword);
  const mismatch = confirmPassword.length > 0 && confirmPassword !== newPassword;
  const canSubmitPassword =
    problem === null &&
    !mismatch &&
    currentPassword.length > 0 &&
    newPassword.length > 0 &&
    confirmPassword.length > 0;

  const changePassword = useMutation({
    mutationFn: () => api.changePassword({ currentPassword, newPassword }),
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setCurrentShown(false);
      setNewShown(false);
      setConfirmShown(false);
      void invalidate();
      // A temporary password has just been replaced: the route guard
      // reads that fact from `GET /api/auth/me`, through a cache that nothing
      // else invalidates here. Without these two lines, the person would stay
      // sent back to this screen even though their key is already changed.
      resetAuthStatus();
      void queryClient.invalidateQueries({ queryKey: queryKeys.authMe });
    },
  });

  const passwordFormMounted = !sessionsOnly && data?.method.password === true;

  const signOutButton = (
    <button
      type="button"
      className={BUTTON.secondary}
      disabled={logout.isPending}
      onClick={() => logout.mutate()}
    >
      {logout.isPending ? t("settingsSecurity.signingOut") : t("settingsSecurity.signOut")}
    </button>
  );

  const passwordSubmitButton = passwordFormMounted ? (
    <button
      type="submit"
      form="settings-password-form"
      className={BUTTON.primary}
      disabled={!canSubmitPassword || changePassword.isPending}
    >
      {changePassword.isPending ? t("settingsSecurity.passwordSubmitting") : t("settingsSecurity.passwordSubmit")}
    </button>
  ) : null;

  const footerActions = (
    <>
      {signOutButton}
      {passwordSubmitButton}
    </>
  );

  /**
   * « Qui est connecté, et comment ». Desktop: a single list, one line per
   * fact (`DESIGN.md` › Bureau), the sign-in method on the last line;
   * sign-out lives at the bottom of the Settings menu and in Mon compte. The
   * phone keeps its two groups and its sign-out in the footer (`contents`:
   * the cards stay direct children of the panel).
   */
  const sessionSection = !data ? null : isMobile ? (
    <div className="contents">
      <SettingsCard className="flex flex-col gap-3">
        <CardHeading
          title={t("settingsSecurity.currentSessionTitle")}
          action={<ToneBadge tone="info">{t("settingsSecurity.currentBadge")}</ToneBadge>}
        />
        <StatusGrid>
          <StatusTile label={t("settingsSecurity.deviceLabel")} icon={<IconDeviceLaptop aria-hidden />} value={describeDevice(current, t)} />
          <StatusTile label={t("settingsSecurity.ipLabel")} icon={<IconWorld aria-hidden />} mono={Boolean(current?.ip)} value={current?.ip ?? t("settingsSecurity.unknownValue")} />
          <StatusTile label={t("settingsSecurity.openedLabel")} icon={<IconClock aria-hidden />} value={current ? formatDate(current.createdAt, locale) : t("settingsSecurity.unknownValue")} />
          <StatusTile label={t("settingsSecurity.lastSeenLabel")} icon={<IconHistory aria-hidden />} value={current ? formatDate(current.lastSeenAt, locale) : t("settingsSecurity.unknownValue")} />
        </StatusGrid>
      </SettingsCard>
      <SettingsCard className="flex flex-col gap-3">
        <CardHeading title={t("settingsSecurity.methodTitle")} />
        <StatusGrid>
          <StatusTile label={t("settingsSecurity.methodEmailLabel")} icon={<IconMail aria-hidden />} value={data.method.email} />
          <StatusTile label={t("settingsSecurity.methodLabel")} icon={<IconShieldLock aria-hidden />} value={methodLabel(data.method, t)} />
        </StatusGrid>
      </SettingsCard>
    </div>
  ) : (
    <ListSection
      title={t("settingsSecurity.currentSessionTitle")}
      action={<ToneBadge tone="info">{t("settingsSecurity.currentBadge")}</ToneBadge>}
    >
      <ListRow label={t("settingsSecurity.deviceLabel")} value={describeDevice(current, t)} />
      <ListRow label={t("settingsSecurity.ipLabel")} mono={Boolean(current?.ip)} value={current?.ip ?? t("settingsSecurity.unknownValue")} />
      <ListRow label={t("settingsSecurity.openedLabel")} value={current ? formatDate(current.createdAt, locale) : t("settingsSecurity.unknownValue")} />
      <ListRow label={t("settingsSecurity.lastSeenLabel")} value={current ? formatDate(current.lastSeenAt, locale) : t("settingsSecurity.unknownValue")} />
      <ListRow label={t("settingsSecurity.methodTitle")} description={data.method.email} value={methodLabel(data.method, t)} />
    </ListSection>
  );

  /**
   * The account's devices: THIS ONE included, first and marked.
   *
   * The table listed only the OTHER sessions. The consequence showed
   * after a reconnect: the session just opened was the
   * current one, therefore filtered, and the old one joined a pile of identical
   * « Révoquée » lines: the screen looked frozen while the database
   * did record both gestures. « Appareils connectés » that does not show
   * the device one is on is not a device list.
   *
   * Zero OTHER devices remains a security FACT, not an absence: the note
   * says so under the table instead of hiding the card.
   */
  // Desktop: the table sits flat in the card, the notes under it.
  const devicesSection = (
    <SettingsCard padded={isMobile} className={isMobile ? "space-y-3" : undefined}>
      <CardHeading
        title={t("settingsSecurity.devicesTitle")}
        action={
          activeOthers.length > 0 ? (
            <button
              type="button"
              className={BUTTON.small}
              disabled={revokeOthers.isPending}
              onClick={() => setConfirmingRevokeOthers(true)}
            >
              {t("settingsSecurity.revokeOthersButton")}
            </button>
          ) : undefined
        }
      />
      {isMobile ? (
        <DevicesList
          sessions={sessions}
          revokingId={revokeSession.isPending ? (revokeSession.variables ?? null) : null}
          onRevoke={(sessionId) => revokeSession.mutate(sessionId)}
          t={t}
          locale={locale}
        />
      ) : (
        <DevicesTable
          sessions={sessions}
          revokingId={revokeSession.isPending ? (revokeSession.variables ?? null) : null}
          onRevoke={(sessionId) => revokeSession.mutate(sessionId)}
          t={t}
          locale={locale}
        />
      )}
      {activeOthers.length === 0 || others.length > activeOthers.length || revokeSession.error ? (
        <div className={isMobile ? "space-y-3" : "space-y-2 border-t border-border/60 px-4 py-3"}>
          {activeOthers.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("settingsSecurity.devicesEmptyDescription")}</p>
          ) : null}
          {others.length > activeOthers.length ? (
            <p className="text-xs text-muted-foreground">{t("settingsSecurity.revokedNote")}</p>
          ) : null}
          {revokeSession.error ? (
            <Note tone="danger" role="alert">
              {securityErrorMessage(revokeSession.error, t)}
            </Note>
          ) : null}
        </div>
      ) : null}
    </SettingsCard>
  );

  const passwordSection = passwordFormMounted ? (
    <SettingsCard className="space-y-4">
      <CardHeading
        title={t("settingsSecurity.passwordTitle")}
        description={t("settingsSecurity.passwordDescription")}
      />
      {/*
        A password field has no reason to be 1500 px wide: the
        panel width is not a form's width. Bounded, the
        « nouveau / confirmer » row stays readable from one end to the other.
      */}
      <form
        id="settings-password-form"
        className="max-w-3xl space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmitPassword) changePassword.mutate();
        }}
      >
        <PasswordField
          id="settings-security-current-password"
          label={t("settingsSecurity.currentPasswordLabel")}
          autoComplete="current-password"
          value={currentPassword}
          shown={currentShown}
          onChange={setCurrentPassword}
          onToggleShown={() => setCurrentShown((shown) => !shown)}
          t={t}
        />
        {/*
          The new password and its confirmation are a single gesture: putting
          them on the same row makes them reread together, and the keyboard
          order (`Tab`) does not change: the grid follows the DOM. The current one stays
          above, alone: it is compared to nothing.
        */}
        <div className={isMobile ? "space-y-3" : "grid gap-3 sm:grid-cols-2"}>
          <PasswordField
            id="settings-security-new-password"
            label={t("settingsSecurity.newPasswordLabel")}
            autoComplete="new-password"
            value={newPassword}
            shown={newShown}
            onChange={setNewPassword}
            onToggleShown={() => setNewShown((shown) => !shown)}
            t={t}
          />
          <PasswordField
            id="settings-security-confirm-password"
            label={t("settingsSecurity.confirmPasswordLabel")}
            autoComplete="new-password"
            value={confirmPassword}
            shown={confirmShown}
            onChange={setConfirmPassword}
            onToggleShown={() => setConfirmShown((shown) => !shown)}
            t={t}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t("settingsSecurity.passwordHint")}</p>
        {isMobile ? null : <div className={ACTIONS}>{passwordSubmitButton}</div>}
      </form>
      {mismatch ? (
        <Note tone="warning" role="alert">
          {t("settingsSecurity.passwordMismatch")}
        </Note>
      ) : null}
      {changePassword.isSuccess ? (
        <Note tone="success" role="status">
          {t("settingsSecurity.passwordSuccess", { count: changePassword.data.revokedOtherSessions })}
        </Note>
      ) : null}
      {changePassword.error ? (
        <Note tone="danger" role="alert">
          {securityErrorMessage(changePassword.error, t)}
        </Note>
      ) : null}
    </SettingsCard>
  ) : (
    <Note tone="info">{t("settingsSecurity.ssoOnlyNote")}</Note>
  );

  return (
    <SettingsPane footer={isMobile && data ? footerActions : undefined}>
      <SectionHeading title={t("settingsSecurity.title")} description={t("settingsSecurity.description")} />

      {/*
        The account was created by the team with a temporary password:
        this is the only screen the application opens until it has been
        replaced (`lib/session/password-change-gate.ts`). The note says why one is
        here, otherwise the redirect would look like a failure.
      */}
      {!sessionsOnly && data?.mustChangePassword ? (
        <Note tone="warning" role="alert">{t("settingsSecurity.mustChangeNote")}</Note>
      ) : null}

      {state.isPending ? <CardSkeleton label={t("settingsSecurity.loading")} /> : null}
      {state.error ? (
        <Note tone="danger" role="alert">
          {state.error instanceof Error ? state.error.message : t("settingsSecurity.readError")}
        </Note>
      ) : null}

      {data ? (
        <>
          {/*
            Three surfaces, three tabs: the page no longer asks one to
            scroll six cards to reach the password form, and
            each tab answers a question: who am I, where else
            am I signed in, how do I change my key.
            An inactive tab is NOT mounted (Radix behavior); the form
            input survives anyway, it lives in this
            component's state, not in the field's DOM.
            On mobile the page stays stacked: the settings panel already has its
            own navigation, one more tab bar above the grouped
            lists would make two levels for a single screen.
          */}
          {sessionsOnly ? <>{sessionSection}{devicesSection}</> : isMobile ? (
            <>
              {sessionSection}
              {devicesSection}
              {passwordSection}
            </>
          ) : (
            // A temporary password opens directly on the tab that
            // replaces it: that is the only thing to do here.
            <Tabs defaultValue={data.mustChangePassword ? "password" : "session"} className="gap-4">
              {/* page canvas === `--control` in dark; muted keeps the raised track */}
              <TabsList className="bg-muted">
                <TabsTrigger value="session" className="px-4">
                  <IconShieldLock aria-hidden />
                  {t("settingsSecurity.tabSession")}
                </TabsTrigger>
                <TabsTrigger value="devices" className="px-4">
                  <IconDevices aria-hidden />
                  {t("settingsSecurity.tabDevices")}
                  {activeOthers.length > 0 ? (
                    <span className="rounded-full bg-muted-foreground/15 px-1.5 text-[11px] leading-4 tabular-nums">
                      {activeOthers.length}
                    </span>
                  ) : null}
                </TabsTrigger>
                <TabsTrigger value="password" className="px-4">
                  <IconKey aria-hidden />
                  {t("settingsSecurity.tabPassword")}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="session" className="flex flex-col gap-4">
                {sessionSection}
              </TabsContent>
              <TabsContent value="devices" className="flex flex-col gap-4">
                {devicesSection}
              </TabsContent>
              <TabsContent value="password" className="flex flex-col gap-4">
                {passwordSection}
              </TabsContent>
            </Tabs>
          )}

          {!sessionsOnly ? <Note tone="neutral">{t("settingsSecurity.hermesNote")}</Note> : null}
        </>
      ) : null}

      {confirmingRevokeOthers ? (
        <Dialog
          open
          onClose={() => {
            if (!revokeOthers.isPending) setConfirmingRevokeOthers(false);
          }}
          role="alertdialog"
          title={t("settingsSecurity.revokeOthersConfirmTitle")}
          description={t("settingsSecurity.revokeOthersConfirmDescription")}
          closeLabel={t("common.close")}
          footer={
            <>
              <button
                type="button"
                className={BUTTON.secondary}
                disabled={revokeOthers.isPending}
                onClick={() => setConfirmingRevokeOthers(false)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className={BUTTON.danger}
                disabled={revokeOthers.isPending}
                onClick={() => revokeOthers.mutate()}
              >
                {revokeOthers.isPending ? t("settingsSecurity.revoking") : t("settingsSecurity.revokeOthersConfirm")}
              </button>
            </>
          }
        >
          {revokeOthers.error ? (
            <p className="text-destructive-text">{securityErrorMessage(revokeOthers.error, t)}</p>
          ) : null}
        </Dialog>
      ) : null}
    </SettingsPane>
  );
}

/** A password field: the pattern from `login.tsx`: eye `aria-pressed`, explicit `htmlFor`. */
/**
 * A password field with its eye: exported because « Mon compte »
 * mounts the SAME form in a modal: two masked fields that would not
 * reveal themselves with the same gesture would be two products.
 */
export function PasswordField({
  id,
  label,
  autoComplete,
  describedBy,
  value,
  shown,
  onChange,
  onToggleShown,
  t,
}: {
  id: string;
  label: string;
  autoComplete: "current-password" | "new-password";
  /** The id of the rule list this field must satisfy, when there is one. */
  describedBy?: string;
  value: string;
  shown: boolean;
  onChange: (value: string) => void;
  onToggleShown: () => void;
  t: ReturnType<typeof useT>["t"];
}) {
  return (
    <div className="space-y-1">
      <label className="text-sm" htmlFor={id}>
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type={shown ? "text" : "password"}
          autoComplete={autoComplete}
          aria-describedby={describedBy}
          required
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={`${FIELD} flex-1`}
        />
        <button
          type="button"
          aria-pressed={shown}
          aria-label={t(shown ? "settingsSecurity.passwordHide" : "settingsSecurity.passwordShow")}
          onClick={onToggleShown}
          /* `min-w-11`: the shell already puts 44 pt of HEIGHT on controls,
             not of WIDTH: the eye was 38 px and missed the thumb. */
          className={`${BUTTON.small} min-w-11`}
        >
          {shown ? <IconEyeOff aria-hidden className="size-4" /> : <IconEye aria-hidden className="size-4" />}
        </button>
      </div>
    </div>
  );
}


function methodLabel(method: AccountAuthMethodDto, t: ReturnType<typeof useT>["t"]): string {
  if (method.password && method.google) return t("settingsSecurity.methodBoth");
  if (method.google) return t("settingsSecurity.methodGoogleOnly");
  return t("settingsSecurity.methodPasswordOnly");
}

/**
 * The API's verdict, said in our words: by `code`, never by the error's
 * text, the pattern from `profile.tsx`. The codes all come from
 * `account-security-routes.ts`.
 */
function securityErrorMessage(error: unknown, t: ReturnType<typeof useT>["t"]): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "ACCOUNT_NOT_FOUND":
        return t("settingsSecurity.errorAccountNotFound");
      case "SESSION_IS_CURRENT":
        return t("settingsSecurity.errorSessionIsCurrent");
      case "SESSION_NOT_FOUND":
        return t("settingsSecurity.errorSessionNotFound");
      case "PASSWORD_NOT_SET":
        return t("settingsSecurity.errorPasswordNotSet");
      case "CREDENTIALS_INVALID":
        return t("settingsSecurity.errorCredentialsInvalid");
      case "PASSWORD_TOO_WEAK":
        return t("settingsSecurity.errorPasswordTooWeak");
      case "PASSWORD_UNCHANGED":
        return t("settingsSecurity.errorPasswordUnchanged");
      case "VALIDATION_ERROR":
        return t("settingsSecurity.errorValidation");
      default:
        break;
    }
  }
  return error instanceof Error ? error.message : t("settingsSecurity.errorGeneric");
}
