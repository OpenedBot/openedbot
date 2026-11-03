import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { cn } from "@openedbot/browser-ui-kit";
import { normalizeUsername, usernameProblem } from "@openedbot/identity/domain/operator";
import type { OperatorProfileDto, OrganizationKind } from "@openedbot/contracts-api";
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
import { fleetHomeHref } from "../../../lib/workspace/workspace-location";
import { useAccountWorkspaces } from "../../../components/workspace/workspace-navigation";
import { useT } from "../../../lib/i18n";
import { writeOnboardingDraft } from "../../../lib/session/onboarding-draft";
import { RadioMark } from "../components/option-card";
import { StepFooter, StepHeading } from "../components/step-shell";

/**
 * Première étape du rail : l'espace de travail, c'est-à-dire l'organisation
 * propre du compte (son type et son nom) et le nom d'utilisateur que les bots
 * emploieront.
 *
 * Personnel et Agence sont deux organisations distinctes ; Agence n'apparaît
 * que si la feature `agency_workspaces` est ouverte, et le choix disparaît
 * quand Personnel est le seul possible. Une fois créée, l'organisation garde
 * son type et le choix disparaît aussi : l'étape ne fait plus que la renommer. Une agence ouvre sa flotte
 * et quitte l'accueil, sans nom d'utilisateur.
 *
 * Le nom d'utilisateur appartient à l'organisation (`operator_profiles`) :
 * il s'enregistre APRÈS la création, sous la nouvelle organisation, puis la
 * page se recharge sur l'étape suivante. S'il est refusé, le rechargement
 * revient ici avec la saisie et la raison du refus (gardées par le brouillon).
 *
 * L'aperçu (`normalizeUsername`) n'est qu'un APERÇU : le cloud API rejuge la
 * même règle et reste seul à décider (`USERNAME_*`).
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
  /** L'organisation propre existe déjà : on relit et on renomme, on ne recrée pas. */
  created: boolean;
  /** Le nom déjà porté par l'organisation, `null` tant qu'elle n'existe pas. */
  workspaceName: string | null;
  /** Rejouer l'étape après un reset de développement, même si l'organisation existe. */
  organizationReset?: boolean;
  /** Le nom d'utilisateur déjà choisi, `null`/`undefined` sinon. */
  operator: OperatorProfileDto | null | undefined;
  /** La saisie gardée par le brouillon quand l'enregistrement a échoué après la création. */
  pendingUsername: string | null;
  /** Le refus de cet enregistrement, redit après le rechargement. */
  pendingUsernameError: string | null;
  /** Verrouille Retour et le rail le temps de l'enregistrement. */
  onBusyChange?: (busy: boolean) => void;
  onAdvance: () => void;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const account = useAccountWorkspaces();
  const agencyAvailable = account.data?.agencyAvailable === true;
  const current = account.data?.workspaces.find((workspace) => workspace.id === activeOrganizationId());
  const existing = current && current.role !== "agency" ? current : null;
  const [chosen, setChosen] = useState<OrganizationKind | null>(null);
  const kind: OrganizationKind = existing?.kind ?? chosen ?? "personal";
  const [name, setName] = useState(organizationReset ? "" : workspaceName ?? "");
  const [username, setUsername] = useState(operator?.username ?? pendingUsername ?? "");
  // Le verdict du cloud API sur CE handle. Effacé dès la frappe suivante : un
  // message qui décrit un handle déjà corrigé est un mensonge affiché.
  const [serverError, setServerError] = useState<string | null>(pendingUsernameError);

  useEffect(() => {
    if (organizationReset || !existing?.name) return;
    setName((currentName) => currentName.trim() ? currentName : existing.name);
  }, [existing?.name, organizationReset]);

  useEffect(() => {
    if (!operator?.username) return;
    setUsername((currentUsername) => currentUsername.trim() ? currentUsername : operator.username);
  }, [operator?.username]);

  const askUsername = kind === "personal";
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
  const usernameReady = !askUsername || (normalized.length > 0 && problem === null);

  const saveUsername = async () => {
    // Le PUT est sauté quand le handle n'a pas bougé : la route est
    // idempotente, mais un 409 sur son propre handle serait absurde à afficher.
    if (normalized !== operator?.username) await api.saveOperator({ username: normalized });
  };

  const create = useMutation({
    mutationFn: () => api.createOrganization({ kind, name: name.trim() }),
    onSuccess: async (organization) => {
      const session = readCloudSession();
      if (session) saveCloudSession({ ...session, organizationId: organization.organizationId });
      if (organization.kind === "agency") {
        window.location.replace(fleetHomeHref(organization.organizationId));
        return;
      }
      // La session porte désormais la nouvelle organisation : le nom
      // d'utilisateur s'enregistre sous elle. Créer l'organisation fait avancer
      // le parcours, sans le terminer.
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
      if (askUsername) {
        try {
          await saveUsername();
        } catch (error) {
          setServerError(usernameErrorMessage(error, normalized, t));
          throw error;
        }
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
  const ready = name.trim().length > 0 && usernameReady && !pending && (created || account.isSuccess)
    && !(kind === "agency" && !agencyAvailable && !created);

  useEffect(() => {
    onBusyChange?.(pending);
    // Nettoyé au démontage : une soumission réussie fait avancer le parcours
    // tout de suite, sans quoi la coque resterait verrouillée à l'étape d'après.
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

  const choice = (value: OrganizationKind, label: string, help: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={kind === value}
      onClick={() => setChosen(value)}
      className={cn(
        "group flex w-full items-start gap-3.5 rounded-lg border bg-card px-4 py-3 text-left transition-all",
        kind === value
          ? "border-foreground shadow-[inset_0_0_0_1px_var(--color-foreground)]"
          : "hover:border-foreground/20 hover:bg-accent/30",
      )}
    >
      <RadioMark selected={kind === value} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-body leading-tight text-foreground">{label}</span>
        <span className="text-caption text-muted-foreground">{help}</span>
      </span>
    </button>
  );

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
            {errorMessage(account.error, t("fleet.error"))}
          </p>
        )}

        {/* Un choix n'en est un qu'à deux, et tant que rien n'est créé : sans
            Agence, Personnel va de soi ; une fois créée, l'organisation garde
            son type. */}
        {agencyAvailable && !created ? (
          <div role="radiogroup" aria-label={t("fleet.orgSetupTitle")} className="flex flex-col gap-2">
            {choice("personal", t("fleet.orgSetupPersonal"), t("fleet.orgSetupPersonalHelp"))}
            {choice("agency", t("fleet.orgSetupAgency"), t("fleet.orgSetupAgencyHelp"))}
          </div>
        ) : null}

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="org-name">{t("fleet.orgSetupName")}</FieldLabel>
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

          {askUsername ? (
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
              {/* L'aperçu montre le handle NORMALISÉ, pas la frappe : « Élodie »
                  devient `@elodie`, et c'est ce que les bots diront. */}
              <FieldDescription>
                {normalized.length > 0 && problem === null
                  ? t("onboarding.step_workspace.username_description", { username: normalized })
                  : t("onboarding.step_workspace.username_pending")}
              </FieldDescription>
            </Field>
          ) : null}
        </FieldGroup>

        {(create.error || (update.error && !serverError)) && (
          <p role="alert" className="text-caption text-destructive-text">
            {errorMessage(create.error ?? update.error, t("fleet.orgSetupError"))}
          </p>
        )}
      </div>

      <StepFooter hint={hint}>
        <ObButton className="w-full" disabled={!ready} onClick={handleSubmit}>
          {pending
            ? t("onboarding.step_workspace.cta_saving")
            : created ? t("onboarding.common.continue") : t("fleet.orgSetupSubmit")}
        </ObButton>
      </StepFooter>
    </>
  );
}

/**
 * Le verdict du cloud API, dit dans nos mots : par `code`, jamais par le texte
 * de l'erreur : c'est le contrat stable des deux clients.
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
