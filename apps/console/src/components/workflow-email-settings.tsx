import { Switch } from "@openedbot/browser-ui-kit";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "../lib/api";
import { useT } from "../lib/i18n";
import { BUTTON, CardHeading, SettingsCard } from "./settings/primitives";

export function WorkflowEmailSettings() {
  const { t, locale } = useT();
  const client = useQueryClient();
  const preferences = useQuery({
    queryKey: queryKeys.workspacePreferences,
    queryFn: api.workspacePreferences,
  });
  const save = useMutation({
    mutationFn: api.saveWorkspacePreferences,
    onSuccess: (data) =>
      client.setQueryData(queryKeys.workspacePreferences, data),
  });
  return (
    <SettingsCard>
      <CardHeading
        title={t("mvp.emailTitle")}
        description={t("mvp.emailHint")}
      />
      {preferences.isPending ? (
        <p role="status">{t("common.loading")}</p>
      ) : preferences.isError ? (
        <div role="alert">
          {t("mvp.loadError")}{" "}
          <button
            className={BUTTON.small}
            onClick={() => void preferences.refetch()}
          >
            {t("errorState.retry")}
          </button>
        </div>
      ) : (
        <fieldset disabled={save.isPending} className="mt-3 space-y-3">
          {(["approval", "completed", "failed"] as const).map((kind) => (
            <label
              key={kind}
              className="flex cursor-pointer items-center justify-between gap-4 text-sm"
            >
              <span>{t(`mvp.${kind}`)}</span>
              <Switch
                checked={preferences.data[kind]}
                aria-label={t(`mvp.${kind}`)}
                onCheckedChange={(enabled) =>
                  save.mutate({ [kind]: enabled, locale })
                }
              />
            </label>
          ))}
        </fieldset>
      )}
      <div className="mt-4 border-t border-border pt-3 text-sm">
        <h3 className="font-medium">{t("mvp.recovery")}</h3>
        <p className="mt-1 text-muted-foreground">{t("mvp.recoveryHint")}</p>
        <a
          className="mt-2 inline-block underline"
          href={`https://docs.openedbot.app/${locale === "fr" ? "fr/" : ""}docs/reglages#${locale === "fr" ? "export-et-récupération" : "export-and-recovery"}`}
          target="_blank"
          rel="noreferrer"
        >
          {t("mvp.openGuide")}
        </a>
      </div>
      {save.isError ? (
        <p role="alert" className="mt-2 text-sm text-destructive-text">
          {t("mvp.saveError")}
        </p>
      ) : null}
    </SettingsCard>
  );
}
