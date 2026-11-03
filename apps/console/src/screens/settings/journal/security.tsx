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
import { signOut } from "../../../lib/session/sign-out";
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

/** Référence stable pour l'état « pas encore chargé » : voir `others` plus bas. */
const EMPTY_SESSIONS: AccountSessionDto[] = [];

/**
 * Sécurité du compte : `/api/account/security`, extrait de `cloud.tsx`
 * (`CloudSecuritySettings`, nom conservé) et enfin traduit.
 *
 * Trois surfaces : la session courante, la méthode de connexion (Google /
 * mot de passe / les deux : jamais devinée, toujours ce que renvoie l'API),
 * et les autres appareils connectés avec leur révocation individuelle ou
 * groupée. Le formulaire de mot de passe ne se monte que si le compte en a
 * un (`method.password`) ; sinon une note dit pourquoi il est absent : un
 * compte SSO-only n'a rien à changer ici (B.6 du plan : pas de « définir un
 * mot de passe » sans mot de passe actuel, ça exigerait une confirmation par
 * e-mail qu'aucun émetteur du dépôt ne sait envoyer).
 */
export function CloudSecuritySettings() {
  const { t, locale } = useT();
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();

  const state = useQuery({ queryKey: queryKeys.accountSecurity, queryFn: api.accountSecurity });
  const data = state.data ?? null;
  // `sessions` garde la référence de la donnée en cache : `DevicesTable` passe
  // ce tableau à TanStack Table, qui traite une nouvelle référence comme de
  // nouvelles données et re-rend en boucle. Un `.filter()` nu à chaque rendu
  // suffisait à déclencher la boucle : d'où la constante vide partagée.
  const sessions = data?.sessions ?? EMPTY_SESSIONS;
  const current = sessions.find((session) => session.current) ?? null;
  // Le badge d'onglet et le bouton « Déconnecter les autres » comptent les
  // AUTRES sessions encore vivantes. Les révoquées restent dans le tableau :
  // c'est l'historique : mais annoncer « Appareils 6 » quand deux sont déjà
  // coupées était un mensonge par omission ; compter la courante en serait un
  // autre, on ne se « déconnecte » pas soi-même par ce bouton.
  const activeOthers = useMemo(
    () => sessions.filter((session) => !session.current && isActiveSession(session)),
    [sessions],
  );
  const others = useMemo(() => sessions.filter((session) => !session.current), [sessions]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.accountSecurity });

  const logout = useMutation({ mutationFn: () => signOut(queryClient) });

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

  // La règle de forme est PARTAGÉE avec l'API (`passwordProblem`) : elle
  // désactive le bouton avant même d'envoyer la requête, mais l'API rejuge
  // la même règle et reste seule à trancher.
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
      // Un mot de passe temporaire vient d'être remplacé : le garde de route
      // lit ce fait dans `GET /api/auth/me`, à travers un cache que rien
      // d'autre n'invalide ici. Sans ces deux lignes, la personne resterait
      // renvoyée sur cet écran alors que sa clé est déjà changée.
      resetAuthStatus();
      void queryClient.invalidateQueries({ queryKey: queryKeys.authMe });
    },
  });

  const passwordFormMounted = data?.method.password === true;

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
   * « Qui est connecté, et comment ». Bureau : une seule liste, une ligne par
   * fait (`DESIGN.md` › Bureau), la méthode de connexion en dernière ligne ;
   * la déconnexion vit en bas du menu des Réglages et dans Mon compte. Le
   * téléphone garde ses deux groupes et sa déconnexion en pied (`contents` :
   * les cartes restent enfants directs du panneau).
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
   * Les appareils du compte : CELUI-CI compris, en tête et marqué.
   *
   * Le tableau ne listait que les AUTRES sessions. La conséquence se voyait
   * après une reconnexion : la session qu'on venait d'ouvrir était la
   * courante, donc filtrée, et l'ancienne rejoignait un tas de lignes
   * « Révoquée » identiques : l'écran semblait figé alors que la base
   * enregistrait bien les deux gestes. « Appareils connectés » qui n'affiche
   * pas l'appareil sur lequel on est n'est pas une liste d'appareils.
   *
   * Zéro AUTRE appareil reste un FAIT de sécurité, pas une absence : la note
   * le dit sous le tableau au lieu d'escamoter la carte.
   */
  const devicesSection = (
    <SettingsCard className="space-y-3">
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
    </SettingsCard>
  );

  const passwordSection = passwordFormMounted ? (
    <SettingsCard className="space-y-4">
      <CardHeading
        title={t("settingsSecurity.passwordTitle")}
        description={t("settingsSecurity.passwordDescription")}
      />
      {/*
        Un champ de mot de passe n'a aucune raison de faire 1500 px : la
        largeur du panneau n'est pas la largeur d'un formulaire. Bornée, la
        rangée « nouveau / confirmer » reste lisible d'un bout à l'autre.
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
          Le nouveau mot de passe et sa confirmation sont un seul geste : les
          mettre sur la même rangée les fait relire ensemble, et l'ordre du
          clavier (`Tab`) ne change pas : la grille suit le DOM. L'actuel reste
          au-dessus, seul : il ne se compare à rien.
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
        Le compte a été créé par l'équipe avec un mot de passe temporaire :
        c'est le seul écran que l'application ouvre tant qu'il n'a pas été
        remplacé (`lib/session/password-change-gate.ts`). La note dit pourquoi on est
        ici, sinon la redirection passerait pour une panne.
      */}
      {data?.mustChangePassword ? (
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
            Trois surfaces, trois onglets : la page ne demande plus de faire
            défiler six cartes pour atteindre le formulaire de mot de passe, et
            chaque onglet répond à une question : qui suis-je, où d'autre
            suis-je connecté, comment je change ma clé.
            Un onglet inactif n'est PAS monté (comportement Radix) ; la saisie
            du formulaire survit quand même, elle vit dans l'état de ce
            composant, pas dans le DOM du champ.
            Sur mobile la page reste empilée : le panneau de réglages a déjà sa
            propre navigation, une barre d'onglets de plus au-dessus des listes
            groupées ferait deux niveaux pour un seul écran.
          */}
          {isMobile ? (
            <>
              {sessionSection}
              {devicesSection}
              {passwordSection}
            </>
          ) : (
            // Un mot de passe temporaire ouvre directement sur l'onglet qui
            // le remplace : c'est la seule chose à faire ici.
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

          <Note tone="neutral">{t("settingsSecurity.hermesNote")}</Note>
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

/** Un champ mot de passe : motif de `login.tsx` : oeil `aria-pressed`, `htmlFor` explicite. */
/**
 * Un champ de mot de passe avec son œil : exporté parce que « Mon compte »
 * monte le MÊME formulaire dans une modale : deux champs masqués qui ne se
 * dévoileraient pas du même geste seraient deux produits.
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
  /** L'id de la liste de règles que ce champ doit satisfaire, quand il y en a une. */
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
          /* `min-w-11` : la coque met déjà 44 pt de HAUT sur les commandes,
             pas de LARGE : l'œil faisait 38 px et se ratait au pouce. */
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
 * Le verdict de l'API, dit dans nos mots : par `code`, jamais par le texte de
 * l'erreur, motif de `profile.tsx`. Les codes viennent tous de
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
