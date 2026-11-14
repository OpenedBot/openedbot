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
 * The operator's username, the one bots use to
 * address them (`@elodie`) instead of the generic `@user`.
 *
 * It is TYPED, never taken from SSO: a Google address says an account, not
 * a name one wants to hear oneself called in a thread. The normalization shown
 * live is only a preview: the cloud API rejudges the same rule and stays the only one
 * to decide, notably on uniqueness against bot slugs (409
 * `USERNAME_TAKEN`), which cannot be decided from here.
 *
 * A LINE of the « Profil » section of « Mon compte », editable in place:
 * the field carries the current value, « Enregistrer » appears only once
 * the value has changed, and the sentence under the label says in turn the current
 * state, the preview, the verdict.
 */
export function UsernameRow() {
  const { t, locale } = useT();
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: queryKeys.operator, queryFn: api.operator });

  const current = state.data?.operator ?? null;
  // `null` = « rien tapé pour l'instant »: the field then shows the server's
  // handle. Copying the response into state on every read would overwrite the
  // keystrokes in progress at the first refresh of the request.
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
      // The roster carries the same profile (`RosterDto.operator`): without this
      // second invalidation, the sidebar's foot would keep
      // showing the old handle until the next reload.
      void queryClient.invalidateQueries({ queryKey: queryKeys.roster });
    },
  });

  // A single sentence at a time, the most urgent first. The preview shows the
  // NORMALIZED handle, not the keystrokes: « Élodie » becomes `@elodie`, and that is what
  // the bots will say.
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
              // Escape restores the saved value: the line becomes a fact again.
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
 * The cloud API's verdict, said in our words: by `code`, never by the text
 * of the error: that is the stable contract of the two clients.
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
