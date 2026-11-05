import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { IconEye, IconEyeOff, IconLock, IconMoon, IconSun } from "@tabler/icons-react";
import { passwordChecks, passwordProblem } from "@openedbot/identity/domain/password";
import { useTheme } from "@openedbot/browser-ui-kit/theme";
import { ApiError, api, queryKeys } from "../../lib/api";
import { resetAuthStatus } from "../../lib/session/auth-status";
import { useT } from "../../lib/i18n";

/**
 * PREMIÈRE CONNEXION AVEC UN MOT DE PASSE TEMPORAIRE.
 *
 * Un compte monté par l'équipe, ou dont l'accès vient d'être rouvert, arrive
 * avec un mot de passe reçu par courrier et le drapeau `must_change_password`
 * levé. Tant qu'il l'est, l'application n'ouvre que cette adresse.
 *
 * C'est un écran À PART, et pas la rubrique « Sécurité » des réglages. Envoyer
 * quelqu'un dans `/settings/**` à sa toute première connexion lui demande de
 * lire un écran d'administration, avec ses sessions, sa méthode de connexion
 * et sa barre latérale, pour trouver le seul champ qui le laisse entrer. Ici
 * il n'y a qu'une chose à faire, et c'est la seule chose affichée.
 *
 * La coque est celle de `/login` (`login.css`, importée globalement) : même
 * gabarit plein écran, mêmes cibles de 44 pt, mêmes champs que `mobile.css`
 * remonte à 16 px pour que Safari iOS ne zoome pas au focus. Une personne qui
 * vient de taper son mot de passe temporaire sur cet écran-là reconnaît
 * celui-ci.
 *
 * La déconnexion reste offerte : personne n'est prisonnier d'un écran.
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

  // La règle de forme est PARTAGÉE avec l'API (`passwordProblem`) : elle
  // désactive le bouton avant l'envoi, et l'API rejuge la même règle. Les
  // trois exigences sont montrées une par une pendant la frappe plutôt
  // qu'annoncées après coup par un refus.
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
      // Le drapeau vient de tomber en base, dans la même transaction que le
      // nouveau hachage. Sans ces deux lignes, le garde de route relirait un
      // `GET /api/auth/me` en cache et renverrait ici quelqu'un qui a déjà
      // changé sa clé.
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
                  La confirmation ne porte PAS d'œil : c'est une saisie à
                  l'aveugle qui vaut relecture. La révéler ferait des deux
                  champs un seul, recopié.
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
 * Un champ secret de la coque `/login`. L'œil est un bouton DANS le champ,
 * d'où le `<div>` et le `htmlFor` : un bouton sous un `<label>` enveloppant
 * deviendrait une seconde cible de l'étiquette.
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
 * Les refus que l'API prononce sur ce chemin. `CREDENTIALS_INVALID` est le
 * seul fréquent : le mot de passe temporaire se recopie d'un courrier, et un
 * caractère de trop se voit mal.
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
