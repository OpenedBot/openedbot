import { canManageWorkspaceMembers } from "@openedbot/contracts-api";
import { useAccountWorkspaces } from "../../../components/workspace/workspace-navigation";
import { useEffect, useState, type ReactNode } from "react";
import { SettingsCardGrid } from "../../../components/settings/settings-card-grid";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconCheck, IconX } from "@tabler/icons-react";
import QRCode from "qrcode";
import { passwordChecks, passwordProblem } from "@openedbot/identity/domain/password";
import type {
  InvitableRole,
  OrganizationMemberDto,
} from "@openedbot/contracts-api";
import { INVITABLE_ROLES } from "@openedbot/contracts-api";
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
import { isNativeShell } from "../../../lib/platform/native-bridge";
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
import { MemberInvitations } from "../../../components/settings/member-invitations";
import { formatDate } from "../../../lib/format";
import { SettingsPane } from "../pane";
import { PasswordField } from "../journal/security";
import { UsernameRow } from "./profile";

type T = ReturnType<typeof useT>["t"];

/**
 * UNE hauteur pour toutes les commandes d'une rangée de formulaire.
 *
 * Une saisie (`FIELD`, hauteur dictée par son `py`), un `SelectTrigger`
 * (36 px) et un `BUTTON` (32 px) côte à côte donnaient trois hauteurs pour
 * trois gestes du même rang : la rangée se lisait comme un défaut d'alignement.
 * Sur téléphone c'est 44 pt, la cible tactile que la coque impose déjà aux
 * commandes de réglages (`.openedbot-settings-action`, `mobile.css`).
 */
const CONTROL_DESKTOP = "h-9";
const CONTROL_MOBILE = "h-11 w-full";

function controlHeight(isMobile: boolean): string {
  return isMobile ? CONTROL_MOBILE : CONTROL_DESKTOP;
}

/**
 * « Mon compte » : qui vous êtes, par où vous entrez, l'espace où vous
 * écrivez, et les personnes qui le partagent, sous une seule route.
 *
 * Mis en LISTE (une section par question, une ligne par fait, la valeur ou la
 * commande à droite) plutôt qu'en grille de cartes et de tuiles : chaque
 * tuile répétait son libellé en capitales et son icône pour un seul mot de
 * valeur, et l'œil zigzaguait entre deux colonnes de cartes de hauteurs
 * différentes. La liste se lit d'un trait, comme les réglages d'OpenBot.
 *
 * Tout ce que la page dit vient de l'API : `GET /api/auth/me` (adresse,
 * espace, rôle), `GET /api/account/security` (lien Google, existence d'un mot
 * de passe), `GET /api/operator` (nom d'utilisateur),
 * `GET /api/organization/members` (membres, `PATCH` / `DELETE /members/:id`).
 *
 * Le geste d'écriture sur les membres est gardé par `session.canWrite` : le
 * rôle `member` lit, le mode assistance lit, parce que l'API refuse déjà
 * (`requireRole`) et qu'un bouton qui part en 403 est un mensonge poli.
 */
export function AccountSettings() {
  return <AccountPage team />;
}

/** Personal account surface without organization members or invitations. */
export function AccountProfileSettings() {
  return <AccountPage team={false} />;
}

function AccountPage({ team }: { team: boolean }) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const session = me.data ?? null;
  const canManage = session?.session.canWrite === true && canManageWorkspaceMembers(session.session.role);
  const impersonating = session?.session.impersonation != null;
  const [mobileMemberInvitationAction, setMobileMemberInvitationAction] = useState<ReactNode>(null);

  // Les sections sont enfants directs du panneau : elles prennent toute sa
  // largeur (comme les réglages d'OpenBot) et son espacement, au bureau comme
  // sur téléphone. Une colonne plafonnée laissait un vide à droite de la modale.
  return (
    <SettingsPane footer={isMobile ? mobileMemberInvitationAction : undefined}>
      <SectionHeading
        title={t("settingsAccount.title")}
        description={t("settingsAccount.description")}
      />
      {impersonating ? <Note tone="warning">{t("settingsAccount.impersonation")}</Note> : null}
      <SettingsCardGrid>
        <ProfileSection />
        <ConnectionSection />
        {isNativeShell() ? null : <MobileSection />}
        <WorkspaceSection />
      </SettingsCardGrid>
      {team && session?.session.role !== "agency" ? (
        <MembersCard
          canManage={canManage}
          impersonating={impersonating}
          invitations={session?.organization.kind === "agency"}
          viewerEmail={session?.user.email ?? null}
          onMobileActionChange={setMobileMemberInvitationAction}
        />
      ) : null}
      {team ? <FleetGrantsCard /> : null}
    </SettingsPane>
  );
}

/** La note d'échec de lecture d'une section, avec le message de l'API s'il y en a un. */
function ReadError({ error }: { error: unknown }) {
  const { t } = useT();
  return (
    <Note tone="danger" role="alert">
      {error instanceof Error ? error.message : t("settingsAccount.readError")}
    </Note>
  );
}

/**
 * Profil : le nom affiché (servi par le fournisseur de connexion, lu) et le
 * nom d'utilisateur (le seul champ que la page écrit).
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
 * Connexion : l'adresse, le lien Google et l'existence d'un mot de passe.
 *
 * Les deux derniers sont des FAITS servis par `GET /api/account/security` :
 * jamais déduits de l'adresse (« ça finit par gmail.com, donc SSO ») ni du
 * fait qu'on soit entré par Google cette fois-ci. Google se lie ici (compte
 * Google de la même adresse) et se délie seulement s'il reste un mot de passe,
 * sans quoi le compte n'aurait plus d'entrée. Le mot de passe se change
 * seulement s'il en existe un : l'API exige l'actuel (`PASSWORD_NOT_SET` sinon).
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
                    // Délier sans mot de passe laisserait le compte sans aucune
                    // entrée : le bouton reste visible mais grisé, la ligne dit
                    // pourquoi. L'API refuse de même (`GOOGLE_UNLINK_NEEDS_PASSWORD`).
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
      {/* Hors du `<ul>` de la section : le dialogue n'est pas une ligne. */}
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

/** Même rythme et même patience que le claim Google de la coque native. */
const GOOGLE_LINK_POLL_MS = 1_500;
const GOOGLE_LINK_TIMEOUT_MS = 5 * 60_000;

type LinkNote = { tone: "success" | "danger"; text: string };

/**
 * Lier Google : la tentative est créée par l'API pour l'utilisateur connecté,
 * Google s'ouvre HORS de la fenêtre (Google refuse les webviews), et la page
 * sonde `google/link/claim` jusqu'à l'issue. Aucune session ne change : le
 * callback Google pose seulement `google_subject` sur ce compte.
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
        // Une sonde perdue (réseau, redémarrage de l'API) n'est pas une issue :
        // la suivante dira où en est la tentative, jusqu'à l'échéance.
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
      // Sur le web, l'onglet s'ouvre DANS le clic, avant la réponse de l'API :
      // ouvert après un `await`, le navigateur le bloque comme fenêtre
      // surgissante. Dans la coque, `window.open` part au navigateur système
      // (`setWindowOpenHandler` d'openedbot-desktop) et rend toujours `null` : on
      // ouvre donc l'URL Google elle-même, une fois connue.
      const native = isNativeShell();
      const tab = native ? null : globalThis.window?.open("", "_blank") ?? null;
      if (tab) {
        try { tab.opener = null; } catch { /* déjà isolé */ }
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
 * Délier Google : le mot de passe actuel est exigé (la même preuve que pour le
 * changer), et les autres appareils sont déconnectés.
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

  // Fermer VIDE la modale, comme `PasswordDialog`, et dans le gestionnaire.
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
 * Application mobile (Mobile Connect) : un QR qui ouvre une session sur l'iPhone sans
 * retaper le mot de passe. Le ticket (`POST /api/auth/mobile-connect/tickets`) vaut dix
 * minutes et ne sert qu'une fois ; l'app le troque contre un code natif lié à son PKCE.
 * Cachée dans la coque native : on n'y scanne pas un QR avec le téléphone qui l'affiche.
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
      {/* Hors du `<ul>` de la section : le dialogue n'est pas une ligne. */}
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

  // Ouvrir demande un ticket ; fermer l'oublie (il reste valable côté API jusqu'à son
  // expiration, mais rien ici ne le rejoue).
  useEffect(() => {
    if (open) {
      create();
    } else {
      ticket.reset();
      setQr(null);
      setExpired(false);
      setCopied(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `ticket.reset` est stable
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
      // Presse-papiers refusé (contexte non sécurisé) : le lien reste sélectionnable.
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

/** L'espace où la session écrit, et ce qu'elle y peut : lu, jamais modifiable ici. */
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
 * Le changement de mot de passe, en modale.
 *
 * La règle de forme est PARTAGÉE avec l'API (`passwordProblem`) : elle
 * désactive le bouton avant l'envoi, et l'API rejuge la même règle et reste
 * seule à trancher. `passwordChecks` la décompose pour que la liste vive
 * pendant la frappe : dire « trop faible » après coup n'apprend rien.
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
   * Fermer VIDE la modale : un mot de passe resté dans un champ est à la fois
   * une surprise à la réouverture et une fuite d'épaule.
   *
   * Dans le gestionnaire, jamais dans un effet : `useMutation` rend un objet
   * neuf à chaque rendu, et un effet qui appelle `reset()` avec cet objet en
   * dépendance boucle jusqu'à « Maximum update depth exceeded ».
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
          La liste des exigences est le retour EN DIRECT de la frappe : chaque
          règle est vraie ou fausse à chaque caractère, jamais après l'envoi.
          `aria-live="polite"` la fait exister aussi pour qui n'en voit pas la
          couleur, et `aria-describedby` la rattache au champ qu'elle juge.
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
 * Une exigence, et si la frappe en cours la satisfait.
 *
 * La pastille se REMPLIT quand la règle passe, elle ne change pas seulement
 * de glyphe : une croix grise qui devient une coche verte de 12 px se rate du
 * coin de l'œil, et l'écran donnait l'impression d'une liste morte. Le libellé
 * porte `data-ok` : c'est ce que les tests lisent, pas une classe.
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

/** Le rôle, dit d'un mot et coloré par son pouvoir : owner porte l'espace. */
function RoleBadge({ role }: { role: string }) {
  const { t } = useT();
  const tone = role === "owner" ? "info" : role === "admin" ? "success" : "neutral";
  return <ToneBadge tone={tone}>{roleLabel(role, t)}</ToneBadge>;
}

function roleLabel(role: string, t: T): string {
  if (role === "owner") return t("settingsAccount.roleOwner");
  if (role === "admin") return t("settingsAccount.roleAdmin");
  if (role === "agency") return t("fleet.role");
  return t("settingsAccount.roleMember");
}

function isInvitableRole(value: string): value is InvitableRole {
  return value === "admin" || value === "member";
}

/**
 * Les membres, avec leurs deux écritures : le rôle et le retrait.
 *
 * L'owner est rendu inerte plutôt qu'absent : `assertMutableMemberRole` le
 * protège côté API, et le masquer laisserait croire que l'espace n'a pas de
 * propriétaire. Soi-même n'est pas retirable : on ne se retire pas d'un espace
 * depuis l'écran qui le gère, on s'en déconnecte.
 */
export function MembersCard({
  canManage,
  impersonating,
  invitations,
  viewerEmail,
  onMobileActionChange,
}: {
  canManage: boolean;
  impersonating: boolean;
  /** Seule une agence invite : un espace personnel n'accueille pas d'autre membre. */
  invitations: boolean;
  viewerEmail: string | null;
  onMobileActionChange?: (action: ReactNode | null) => void;
}) {
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
    mutationFn: (input: { userId: string; role: InvitableRole }) =>
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
        {/* `isLoading` et non `isPending` : sans organisation active la requête
            reste désactivée (donc `pending` à jamais), et un squelette éternel
            mentirait. */}
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

      {invitations && canManage && !impersonating ? <MemberInvitations onMobileActionChange={onMobileActionChange} /> : null}

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
  onRole: (role: InvitableRole) => void;
  onRemove: () => void;
}) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const viewer = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const name = memberName(member);
  const isOwner = member.role === "owner";
  // L'owner est protégé par l'API (`assertMutableMemberRole`), et on ne se
  // retire pas soi-même : les deux commandes se ferment plutôt que d'échouer.
  // Aucune membership ne porte le rôle agence depuis 0086 : une agence entre par un grant.
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
          onValueChange={(role) => { if (isInvitableRole(role)) onRole(role); }}
          disabled={busy}
        >
          <SelectTrigger
            size="sm"
            className={cn(controlHeight(isMobile), !isMobile && "w-36")}
            aria-label={t("settingsAccount.memberRoleAria", { member: name })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {INVITABLE_ROLES.map((role) => (
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
 * Le verdict de l'API, dit dans nos mots : par `code`, jamais par le texte de
 * l'erreur : c'est le contrat stable, et le message serveur reste le repli
 * pour ce que ce fichier ne connaît pas encore.
 */
function memberErrorMessage(error: unknown, t: T): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "MEMBER_ALREADY_INVITED": return t("settingsAccount.errorAlreadyMember");
      case "MEMBER_QUOTA_REACHED": return t("settingsAccount.errorQuota");
      case "SUBSCRIPTION_REQUIRED": return t("settingsAccount.errorSubscription");
      case "OWNER_ROLE_PROTECTED": return t("settingsAccount.errorOwnerProtected");
      case "MEMBER_SUBMISSION_IN_PROGRESS": return t("settingsAccount.errorMemberBusy");
      case "ROLE_INVALID": return t("settingsAccount.errorRole");
      default: break;
    }
  }
  return error instanceof Error ? error.message : t("settingsAccount.readError");
}


/**
 * Les agences que cet espace client laisse entrer (0086). Un grant vise une
 * ORGANISATION agence : le retirer coupe l'accès de tous ses membres à la fois.
 */
function FleetGrantsCard() {
  const { t, locale } = useT();
  const queryClient = useQueryClient();
  const viewer = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const account = useAccountWorkspaces();
  const organizationId = activeOrganizationId();
  const role = viewer.data?.session.role;
  const current = account.data?.workspaces.find((w) => w.id === organizationId);
  const visible = account.data?.agencyAvailable === true && current?.kind === "personal" && current.role !== "agency"
    && (role === "owner" || role === "admin");
  const grants = useQuery({ queryKey: ["fleet-grants", organizationId], queryFn: api.fleetGrants, enabled: visible });
  const revoke = useMutation({
    mutationFn: api.revokeFleetGrant,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["fleet-grants", organizationId] }),
  });
  if (!visible) return null;
  const rows = grants.data?.grants ?? [];
  // Pas de section vide : le mode agence est en standby. On ne l'ouvre que
  // s'il y a un grant à retirer, ou une erreur de lecture.
  if (!grants.error && rows.length === 0) return null;
  const notes = [
    grants.error ? <Note key="read" tone="danger" role="alert">{errorMessage(grants.error, t("fleet.error"))}</Note> : null,
    revoke.error ? <Note key="revoke" tone="danger" role="alert">{errorMessage(revoke.error, t("fleet.error"))}</Note> : null,
  ].filter(Boolean);
  return (
    <ListSection
      title={t("fleet.grantsTitle")}
      description={t("fleet.grantsDescription")}
      footer={notes.length > 0 ? notes : undefined}
    >
      {rows.map((grant) => (
        <ListRow
          key={grant.id}
          label={grant.agencyName}
          description={t("fleet.grantsSince", { date: formatDate(grant.createdAt, locale) })}
        >
          {role === "owner" ? (
            <button type="button" className={BUTTON.danger} disabled={revoke.isPending} onClick={() => revoke.mutate(grant.id)}>
              {t("fleet.grantsRevoke")}
            </button>
          ) : null}
        </ListRow>
      ))}
    </ListSection>
  );
}
