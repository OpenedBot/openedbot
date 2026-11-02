import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, Switch, toast } from "@openedbot/browser-ui-kit";
import { YOLO_SOLO_NOT_ELIGIBLE_CODE } from "@openedbot/contracts-api";
import { ApiError, api, errorMessage, queryKeys } from "../../../../lib/api";
import { activeFleetId } from "../../../../lib/session/cloud-session";
import { useT } from "../../../../lib/i18n";
import { BUTTON, CardHeading, Note, SettingsCard } from "../../../../components/settings/primitives";

/**
 * Mode YOLO, solo local : l'interrupteur « YOLO par défaut (solo) ». Il n'existe
 * que pour l'owner d'un espace à un seul membre (`soloEligible`, dit par
 * l'API) ; jamais en contexte d'agence. L'activer la première fois (aucune
 * confirmation YOLO enregistrée) passe par une confirmation `alertdialog` ;
 * le couper ne demande rien. L'interrupteur montre ce que l'API a relu,
 * jamais le clic.
 */
export function RuntimeYoloSoloSwitch() {
  const { t } = useT();
  const queryClient = useQueryClient();
  const key = queryKeys.yoloSoloConsent;
  const agency = Boolean(activeFleetId());
  const consent = useQuery({ queryKey: key, queryFn: api.yoloSoloConsent, enabled: !agency });
  const [confirming, setConfirming] = useState(false);
  const toggle = useMutation({
    mutationFn: (value: boolean) => api.setYoloSoloDefault(value),
    onSuccess: (saved) => {
      setConfirming(false);
      queryClient.setQueryData(key, saved);
      toast.success(saved.soloDefault ? t("yoloSolo.on") : t("yoloSolo.off"));
    },
    onError: (error) => {
      setConfirming(false);
      toast.error(error instanceof ApiError && error.code === YOLO_SOLO_NOT_ELIGIBLE_CODE
        ? t("yoloSolo.notEligible")
        : errorMessage(error, t("yoloSolo.failed")));
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const data = consent.data;
  const describedBy = "runtime-yolo-solo-protections";

  if (agency) return null;
  if (consent.isError) {
    return (
      <SettingsCard className="space-y-3" data-runtime-yolo-solo="">
        <CardHeading title={t("yoloSolo.title")} description={t("yoloSolo.description")} />
        <Note tone="danger" role="alert">{t("yoloSolo.loadFailed")}</Note>
      </SettingsCard>
    );
  }
  if (!data?.soloEligible) return null;

  const change = (value: boolean): void => {
    if (value && data.acknowledgedAt === null) setConfirming(true);
    else toggle.mutate(value);
  };

  return (
    <SettingsCard className="space-y-3" data-runtime-yolo-solo="">
      <CardHeading title={t("yoloSolo.title")} description={t("yoloSolo.description")} />
      <label className="flex min-h-11 items-center justify-between gap-3">
        <span className="text-sm text-text-primary">{t("yoloSolo.label")}</span>
        <Switch
          checked={data.soloDefault}
          onCheckedChange={change}
          disabled={toggle.isPending}
          aria-describedby={describedBy}
          className="shrink-0"
        />
      </label>
      <p id={describedBy} className="text-xs leading-5 text-warn-700">{t("yoloSolo.protections")}</p>
      <p className="text-xs text-text-tertiary">{t("yoloSolo.endsWhen")}</p>
      {confirming ? (
        <Dialog
          open
          onClose={() => { if (!toggle.isPending) setConfirming(false); }}
          role="alertdialog"
          title={t("yoloSolo.confirmTitle")}
          description={t("yoloSolo.confirmDescription")}
          closeLabel={t("common.close")}
          footer={
            <>
              <button type="button" className={BUTTON.secondary} disabled={toggle.isPending} onClick={() => setConfirming(false)}>
                {t("common.cancel")}
              </button>
              <button type="button" className={BUTTON.danger} disabled={toggle.isPending} onClick={() => toggle.mutate(true)}>
                {toggle.isPending ? t("yoloSolo.confirmPending") : t("yoloSolo.confirm")}
              </button>
            </>
          }
        />
      ) : null}
    </SettingsCard>
  );
}
