import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { IconEye, IconEyeOff, IconLock, IconMoon, IconSun } from "@tabler/icons-react";
import { passwordChecks, passwordProblem } from "@openedbot/identity/domain/password";
import { useTheme } from "@openedbot/browser-ui-kit/theme";
import { ApiError, api, queryKeys } from "../../lib/api";
import { resetAuthStatus } from "../../lib/session/auth-status";
import { useT } from "../../lib/i18n";

/**
 * FIRST SIGN-IN WITH A TEMPORARY PASSWORD.
 *
 * An account set up by the team, or whose access has just been reopened, arrives
 * with a password received by mail and the `must_change_password`
 * flag raised. While it is raised, the application opens only this address.
 *
 * This is a screen APART, and not the « Sécurité » section of settings. Sending
 * someone into `/settings/**` on their very first sign-in asks them to
 * read an administration screen, with its sessions, its sign-in method
 * and its sidebar, to find the only field that lets them in. Here
 * there is only one thing to do, and it is the only thing shown.
 *
 * The shell is `/login`'s (`login.css`, imported globally): the same
 * full-screen form factor, the same 44 pt targets, the same fields that `mobile.css`
 * raises to 16 px so Safari iOS does not zoom on focus. A person who
 * has just typed their temporary password on that screen recognizes
 * this one.
 *
 * Sign-out stays offered: nobody is a prisoner of a screen.
 */
export function ChangePasswordScreen({ onDone }: { onDone: () => void }) {
  const { locale, setLocale, t } = useT();
  const theme = useTheme();
  const queryClient = useQueryClient();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [currentShown, setCurrentShown] = useState(false);
  const [newShown, setNewShown] = useState(false);

  // The shape rule is SHARED with the API (`passwordProblem`): it
  // disables the button before the send, and the API rejudges the same rule. The
  // three requirements are shown one by one while typing rather than
  // announced afterwards by a refusal.
  const checks = passwordChecks(newPassword);
  const problem = passwordProblem(newPassword, currentPassword);
  const mismatch = confirmPassword.length > 0 && confirmPassword !== newPassword;
  const canSubmit =
    problem === null
    && !mismatch
    && currentPassword.length > 0
    && confirmPassword.length > 0;

  const change = useMutation({
    mutationFn: () => api.changePassword({ currentPassword, newPassword }),
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      // The flag has just dropped in the database, in the same transaction as the
      // new hash. Without these two lines, the route guard would reread a
      // cached `GET /api/auth/me` and send back here someone who has already
      // changed their key.
      resetAuthStatus();
      void queryClient.invalidateQueries({ queryKey: queryKeys.authMe });
      onDone();
    },
  });

  const logout = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      resetAuthStatus();
      window.location.assign("/login");
    },
  });

  return (
    <div className="lg">
      <div className="lg-shell">
        <section className="lg-main">
          <span className="lg-brand">
            <span className="lg-brand-mark">
              <img src="/brand/openedbot-icon.webp" alt="" aria-hidden="true" />
            </span>
            <span>openedbot</span>
          </span>

          <div className="lg-content">
            <div className="lg-copy">
              <h1 className="lg-title">{t("changePassword.title")}</h1>
              <p className="lg-lead">{t("changePassword.intro")}</p>
            </div>

            <div className="lg-actions">
              <form
                className="lg-password"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (canSubmit && !change.isPending) change.mutate();
                }}
              >
                <SecretField
                  id="cp-current"
                  label={t("changePassword.currentLabel")}
                  autoComplete="current-password"
                  value={currentPassword}
                  shown={currentShown}
                  onChange={setCurrentPassword}
                  onToggle={() => setCurrentShown((shown) => !shown)}
                  showLabel={t(currentShown ? "login.passwordHide" : "login.passwordShow")}
                />
                <SecretField
                  id="cp-new"
                  label={t("changePassword.newLabel")}
                  autoComplete="new-password"
                  value={newPassword}
                  shown={newShown}
                  onChange={setNewPassword}
                  onToggle={() => setNewShown((shown) => !shown)}
                  showLabel={t(newShown ? "login.passwordHide" : "login.passwordShow")}
                />
                {/*
                  The confirmation does NOT carry an eye: it is a blind
                  entry that counts as a reread. Revealing it would make the two
                  fields one, copied.
                */}
                <SecretField
                  id="cp-confirm"
                  label={t("changePassword.confirmLabel")}
                  autoComplete="new-password"
                  value={confirmPassword}
                  shown={false}
                  onChange={setConfirmPassword}
                />

                <ul className="lg-rules" aria-live="polite">
                  <Rule ok={checks.length}>{t("changePassword.ruleLength")}</Rule>
                  <Rule ok={checks.uppercase}>{t("changePassword.ruleUppercase")}</Rule>
                  <Rule ok={checks.symbol}>{t("changePassword.ruleSymbol")}</Rule>
                </ul>

                {mismatch ? (
                  <div className="lg-note" data-tone="warning" role="alert">
                    {t("changePassword.mismatch")}
                  </div>
                ) : null}
                {change.error ? (
                  <div className="lg-note" data-tone="danger" role="alert">
                    {errorMessage(change.error, t)}
                  </div>
                ) : null}

                <button type="submit" className="lg-submit" disabled={!canSubmit || change.isPending}>
                  {change.isPending ? t("changePassword.submitting") : t("changePassword.submit")}
                </button>
                <button
                  type="button"
                  className="lg-ghost"
                  disabled={logout.isPending}
                  onClick={() => logout.mutate()}
                >
                  {logout.isPending ? t("changePassword.signingOut") : t("changePassword.signOut")}
                </button>
              </form>
            </div>
          </div>

          <div className="lg-footer">
            <div className="lg-legal">
              <p>{t("changePassword.footnote")}</p>
            </div>
            <div className="lg-footer-controls">
              <fieldset className="lg-locale">
                <legend className="lg-sr-only">{t("settings.appearance.languageTitle")}</legend>
                {(["fr", "en"] as const).map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    aria-pressed={locale === candidate}
                    onClick={() => setLocale(candidate)}
                    className="lg-locale-option"
                  >
                    {candidate}
                  </button>
                ))}
              </fieldset>
              <button
                type="button"
                role="switch"
                aria-checked={theme.resolved === "dark"}
                aria-label={t(
                  theme.resolved === "dark"
                    ? "settings.appearance.themeLight"
                    : "settings.appearance.themeDark",
                )}
                onClick={() => theme.setMode(theme.resolved === "dark" ? "light" : "dark")}
                className="lg-theme-toggle"
              >
                {theme.resolved === "dark" ? <IconMoon aria-hidden="true" /> : <IconSun aria-hidden="true" />}
              </button>
            </div>
          </div>
        </section>
        <aside className="lg-panel" aria-hidden="true" />
      </div>
    </div>
  );
}

/**
 * A secret field of the `/login` shell. The eye is a button INSIDE the field,
 * hence the `<div>` and the `htmlFor`: a button under a wrapping `<label>`
 * would become a second target of the label.
 */
function SecretField({
  id,
  label,
  autoComplete,
  value,
  shown,
  onChange,
  onToggle,
  showLabel,
}: {
  id: string;
  label: string;
  autoComplete: "current-password" | "new-password";
  value: string;
  shown: boolean;
  onChange: (next: string) => void;
  onToggle?: () => void;
  showLabel?: string;
}) {
  return (
    <div className="lg-field">
      <label htmlFor={id}>{label}</label>
      <span className={onToggle ? "lg-field-control lg-field-control--secret" : "lg-field-control"}>
        <IconLock aria-hidden="true" />
        <input
          id={id}
          type={shown ? "text" : "password"}
          autoComplete={autoComplete}
          required
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        {onToggle ? (
          <button
            type="button"
            className="lg-eye"
            aria-pressed={shown}
            aria-label={showLabel}
            onClick={onToggle}
          >
            {shown ? <IconEyeOff aria-hidden="true" /> : <IconEye aria-hidden="true" />}
          </button>
        ) : null}
      </span>
    </div>
  );
}

function Rule({ ok, children }: { ok: boolean; children: string }) {
  return (
    <li className="lg-rule" data-ok={ok ? "true" : "false"}>
      <span aria-hidden="true">{ok ? "✓" : "•"}</span>
      {children}
    </li>
  );
}

/**
 * The refusals the API pronounces on this path. `CREDENTIALS_INVALID` is the
 * only frequent one: the temporary password is copied from a mail, and one
 * extra character is hard to see.
 */
function errorMessage(error: unknown, t: ReturnType<typeof useT>["t"]): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "CREDENTIALS_INVALID":
        return t("changePassword.errorCurrentInvalid");
      case "PASSWORD_TOO_WEAK":
        return t("changePassword.errorTooWeak");
      case "PASSWORD_UNCHANGED":
        return t("changePassword.errorUnchanged");
      case "PASSWORD_NOT_SET":
        return t("changePassword.errorNotSet");
      default:
        break;
    }
  }
  return t("changePassword.errorGeneric");
}
