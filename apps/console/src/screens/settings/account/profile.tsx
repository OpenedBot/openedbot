import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { normalizeUsername, usernameProblem } from "@openedbot/identity/domain/operator";
import { cn, useIsMobile } from "@openedbot/browser-ui-kit";
import { ApiError, api, queryKeys } from "../../../lib/api";
import { BUTTON, FIELD, ListRow } from "../../../components/settings/primitives";
import { formatDate } from "../../../lib/format";
import { useT } from "../../../lib/i18n";

const HINT_ID = "settings-profile-hint";

/**
 * Le nom d'utilisateur de l'opérateur, celui que les bots emploient pour
 * l'interpeller (`@elodie`) au lieu du `@user` générique.
 *
 * Il est SAISI, jamais repris du SSO : une adresse Google dit un compte, pas
 * un nom qu'on veut s'entendre appeler dans un fil. La normalisation affichée
 * en direct n'est qu'un aperçu : le cloud API rejuge la même règle et reste seul
 * à trancher, notamment sur l'unicité face aux slugs de bots (409
 * `USERNAME_TAKEN`), qu'on ne peut pas décider d'ici.
 *
 * Une LIGNE de la section « Profil » de « Mon compte », éditable sur place :
 * le champ porte la valeur actuelle, « Enregistrer » n'apparaît qu'une fois
 * la valeur changée, et la phrase sous le libellé dit tour à tour l'état
 * actuel, l'aperçu, le verdict.
 */
export function UsernameRow() {
  const { t, locale } = useT();
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: queryKeys.operator, queryFn: api.operator });

  const current = state.data?.operator ?? null;
  // `null` = « rien tapé pour l'instant » : le champ montre alors le handle
  // du serveur. Recopier la réponse dans l'état à chaque lecture écraserait la
  // frappe en cours au premier rafraîchissement de la requête.
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? current?.username ?? "";

  const normalized = normalizeUsername(value);
  const problem = usernameProblem(normalized);
  const dirty = draft !== null && normalized !== (current?.username ?? "");

  const save = useMutation({
    mutationFn: () => api.saveOperator({ username: normalized }),
    onSuccess: () => {
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.operator });
      // Le roster porte le même profil (`RosterDto.operator`) : sans cette
      // seconde invalidation, le pied de la barre latérale continuerait
      // d'afficher l'ancien handle jusqu'au prochain rechargement.
      void queryClient.invalidateQueries({ queryKey: queryKeys.roster });
    },
  });

  // Une seule phrase à la fois, la plus urgente d'abord. L'aperçu montre le
  // handle NORMALISÉ, pas la frappe : « Élodie » devient `@elodie`, et c'est ce
  // que les bots diront.
  let hint: ReactNode;
  let tone: "muted" | "danger" | "success" = "muted";
  if (state.error) {
    hint = state.error instanceof Error ? state.error.message : t("settingsProfile.readError");
    tone = "danger";
  } else if (save.error) {
    hint = saveErrorMessage(save.error, normalized, t);
    tone = "danger";
  } else if (dirty && problem) {
    hint = t(problem === "reserved" ? "settingsProfile.errorReserved" : "settingsProfile.errorInvalid");
    tone = "danger";
  } else if (dirty) {
    hint = t("settingsProfile.preview", { username: normalized });
  } else if (save.isSuccess) {
    hint = t("settingsProfile.saved", { username: save.data.operator.username });
    tone = "success";
  } else if (current) {
    hint = t("settingsProfile.current", {
      username: current.username,
      date: formatDate(current.updatedAt, locale),
    });
  } else if (state.data) {
    hint = t("settingsProfile.notSet");
  }

  return (
    <ListRow
      label={t("settingsProfile.fieldLabel")}
      stacked
      descriptionId={HINT_ID}
      description={
        hint ? (
          <span
            role="status"
            className={cn(tone === "danger" && "text-destructive-text", tone === "success" && "text-pos-700")}
          >
            {hint}
          </span>
        ) : undefined
      }
    >
      <form
        id="settings-profile-form"
        className={cn("flex items-center gap-2", isMobile && "w-full")}
        onSubmit={(event) => {
          event.preventDefault();
          if (dirty && !problem && !save.isPending) save.mutate();
        }}
      >
        {dirty ? (
          <button
            type="submit"
            disabled={problem !== null || save.isPending}
            className={BUTTON.primary}
          >
            {save.isPending ? t("settingsProfile.saving") : t("settingsProfile.save")}
          </button>
        ) : null}
        <span className={cn("relative", isMobile && "order-first flex-1")}>
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-3 flex items-center font-mono text-sm text-muted-foreground"
          >
            @
          </span>
          <input
            value={value}
            onChange={(event) => {
              setDraft(event.target.value);
              if (save.error || save.isSuccess) save.reset();
            }}
            onKeyDown={(event) => {
              // Échap rend la valeur enregistrée : la ligne redevient un fait.
              if (event.key === "Escape" && draft !== null) {
                event.preventDefault();
                setDraft(null);
                save.reset();
              }
            }}
            disabled={!state.data}
            aria-label={t("settingsProfile.fieldLabel")}
            aria-describedby={HINT_ID}
            aria-invalid={dirty && problem !== null ? true : undefined}
            placeholder={t("settingsProfile.placeholder")}
            autoComplete="off"
            spellCheck={false}
            className={cn(FIELD, "py-0 pl-7", isMobile ? "h-11 w-full" : "h-9 w-44")}
          />
        </span>
      </form>
    </ListRow>
  );
}

/**
 * Le verdict du cloud API, dit dans nos mots : par `code`, jamais par le texte
 * de l'erreur : c'est le contrat stable des deux clients.
 */
function saveErrorMessage(
  error: unknown,
  username: string,
  t: ReturnType<typeof useT>["t"],
): string {
  if (error instanceof ApiError) {
    if (error.code === "USERNAME_INVALID") return t("settingsProfile.errorInvalid");
    if (error.code === "USERNAME_RESERVED") return t("settingsProfile.errorReserved");
    if (error.code === "USERNAME_TAKEN") return t("settingsProfile.errorTaken", { username });
  }
  return error instanceof Error ? error.message : t("settingsProfile.errorInvalid");
}
