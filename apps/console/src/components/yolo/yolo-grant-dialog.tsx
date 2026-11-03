import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { YoloGrantRequest, YoloLeaseDto, YoloScope } from "@openedbot/contracts-api";
import { Dialog, toast } from "@openedbot/browser-ui-kit";
import { api, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { BUTTON, FIELD, Note } from "../settings/primitives";
import {
  invalidateYolo,
  isYoloAckRequired,
  YOLO_DEFAULT_HOURS,
  YOLO_DURATION_HOURS,
  yoloErrorMessage,
  yoloReachable,
} from "./yolo-shared";

/**
 * « Activer YOLO » : la portée (parmi `scopes`), la durée (4 h par défaut,
 * 24 h au plus), puis l'octroi sur le runtime actif. La première fois, une
 * confirmation `alertdialog` dit ce que YOLO lève et ce qu'il garde ; elle
 * envoie `acknowledged`, puis enregistre le consentement (`PUT /consent`) :
 * elle ne se redemande plus. Un refus de l'API (plafond, revue imposée,
 * hôte trop ancien…) se lit dans la boîte avec sa raison, jamais avalé.
 */
export function YoloGrantDialog({
  open,
  onClose,
  scopes,
  botId,
  threadId,
}: {
  open: boolean;
  onClose: () => void;
  /** Les portées proposées, la première cochée d'office. */
  scopes: readonly YoloScope[];
  botId?: string;
  threadId?: string;
}) {
  if (!open) return null;
  return <GrantFlow onClose={onClose} scopes={scopes} botId={botId} threadId={threadId} />;
}

function GrantFlow({
  onClose,
  scopes,
  botId,
  threadId,
}: {
  onClose: () => void;
  scopes: readonly YoloScope[];
  botId?: string;
  threadId?: string;
}) {
  const { t, formatDate } = useT();
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<YoloScope>(scopes[0] ?? "bot");
  const [hours, setHours] = useState<number>(YOLO_DEFAULT_HOURS);
  const [confirmingFirstTime, setConfirmingFirstTime] = useState(false);
  const consent = useQuery({ queryKey: queryKeys.yoloConsent, queryFn: api.yoloConsent, enabled: yoloReachable(), retry: false });
  // Un consentement illisible vaut « pas encore donné » : on confirme une
  // fois de trop plutôt qu'une fois de moins.
  const acknowledged = Boolean(consent.data?.acknowledgedAt);

  const grant = useMutation({
    mutationFn: async (withAck: boolean): Promise<YoloLeaseDto> => {
      const input: YoloGrantRequest = {
        scope,
        ...(scope !== "runtime" && botId ? { botId } : {}),
        ...(scope === "thread" && threadId ? { threadId } : {}),
        durationMinutes: hours * 60,
        ...(withAck ? { acknowledged: true } : {}),
      };
      const { lease } = await api.grantYoloLease(input);
      if (withAck) {
        // L'octroi a déjà enregistré la confirmation dans sa transaction
        // (`grant_permission_yolo_lease`) : ce PUT la rend explicite et lisible
        // par les autres écrans. Son échec ne retire donc rien au bail.
        const saved = await api.saveYoloConsent().catch(() => null);
        if (saved) queryClient.setQueryData(queryKeys.yoloConsent, saved);
        else void queryClient.invalidateQueries({ queryKey: queryKeys.yoloConsent });
      }
      return lease;
    },
    onSuccess: async (lease) => {
      toast.success(t("yolo.granted", { scope: t(`yolo.scope.${lease.scope}`), date: formatDate(lease.expiresAt) }));
      await invalidateYolo(queryClient);
      onClose();
    },
    onError: (error) => {
      // Le serveur ne connaît pas (ou plus) la confirmation : on la demande.
      if (isYoloAckRequired(error)) setConfirmingFirstTime(true);
    },
  });

  const submit = () => {
    if (grant.isPending) return;
    if (!acknowledged) setConfirmingFirstTime(true);
    else grant.mutate(false);
  };
  const close = () => {
    if (!grant.isPending) onClose();
  };
  const error = grant.error && !isYoloAckRequired(grant.error)
    ? yoloErrorMessage(grant.error, t, t("yolo.grantFailed"))
    : null;

  return (
    <>
      <Dialog
        open
        onClose={close}
        title={t("yolo.grantTitle")}
        description={t("yolo.grantDescription")}
        closeLabel={t("common.close")}
        swipeToDismiss={false}
        footer={(
          <>
            <button type="button" className={BUTTON.secondary} disabled={grant.isPending} onClick={close}>
              {t("common.cancel")}
            </button>
            <button type="button" className={BUTTON.primary} disabled={grant.isPending || consent.isLoading} onClick={submit}>
              {grant.isPending ? t("yolo.granting") : t("yolo.grantConfirm")}
            </button>
          </>
        )}
      >
        <div className="space-y-4" data-yolo-grant="">
          {scopes.length > 1 ? (
            <fieldset className="space-y-2" disabled={grant.isPending}>
              <legend className="text-sm font-medium">{t("yolo.scopeLegend")}</legend>
              {scopes.map((option) => (
                <label key={option} className="flex min-h-11 items-start gap-2 py-1 text-sm">
                  <input
                    type="radio"
                    name="yolo-grant-scope"
                    className="mt-1"
                    checked={scope === option}
                    onChange={() => setScope(option)}
                  />
                  <span className="flex flex-col">
                    <span>{t(`yolo.scopeLabel.${option}`)}</span>
                    <span className="text-xs text-muted-foreground">{t(`yolo.scopeHint.${option}`)}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}
          <div className="space-y-1.5">
            <label htmlFor="yolo-grant-duration" className="block text-sm font-medium">{t("yolo.durationLabel")}</label>
            <select
              id="yolo-grant-duration"
              className={`${FIELD} w-full sm:w-auto`}
              disabled={grant.isPending}
              value={hours}
              onChange={(event) => setHours(Number(event.currentTarget.value))}
            >
              {YOLO_DURATION_HOURS.map((option) => {
                const label = t("yolo.durationHours", { hours: option });
                return (
                  <option key={option} value={option}>
                    {option === YOLO_DEFAULT_HOURS ? t("yolo.durationDefault", { label }) : label}
                  </option>
                );
              })}
            </select>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">{t("yolo.grantFloor")}</p>
          {error ? <Note tone="danger" role="alert">{error}</Note> : null}
        </div>
      </Dialog>
      {confirmingFirstTime ? (
        <Dialog
          open
          onClose={() => { if (!grant.isPending) setConfirmingFirstTime(false); }}
          role="alertdialog"
          title={t("yolo.firstTimeTitle")}
          description={t("yolo.firstTimeDescription")}
          closeLabel={t("common.close")}
          swipeToDismiss={false}
          footer={(
            <>
              <button type="button" className={BUTTON.secondary} disabled={grant.isPending} onClick={() => setConfirmingFirstTime(false)}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className={BUTTON.danger}
                disabled={grant.isPending}
                onClick={() => {
                  setConfirmingFirstTime(false);
                  grant.mutate(true);
                }}
              >
                {t("yolo.firstTimeConfirm")}
              </button>
            </>
          )}
        >
          <ul className="list-disc space-y-2 ps-5" data-yolo-first-time="">
            <li>{t("yolo.firstTimeAuto")}</li>
            <li>{t("yolo.firstTimeFloor")}</li>
            <li>{t("yolo.firstTimeAudit")}</li>
          </ul>
        </Dialog>
      ) : null}
    </>
  );
}
