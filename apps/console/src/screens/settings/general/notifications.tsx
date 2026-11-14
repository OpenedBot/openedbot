// TODO(notifications): the Web Push subscription depended on the PWA service worker, removed.
// Push notifications must move to the desktop app / APNs;
// the API-side send (/api/push-subscriptions, @openedbot/notifications) stays in place.
import { WorkflowEmailSettings } from "../../../components/workflow-email-settings";
import { useEffect, useState } from "react";
import { useIsMobile } from "@openedbot/browser-ui-kit";
import {
  BUTTON,
  CardHeading,
  Note,
  SectionHeading,
  SettingsCard,
  ToneBadge,
  type Tone,
} from "../../../components/settings/primitives";
import { useT } from "../../../lib/i18n";
import {
  disableWebNotifications,
  enableWebNotifications,
  readWebNotificationPreference,
  webNotificationPermissionState,
  WEB_NOTIFICATION_PREFERENCE_EVENT,
  type WebNotificationPermissionState,
} from "../../../lib/run/web-workflow-notifications";
import { InsetGroupedSection, InsetGroupedStatic } from "../../../components/mobile/inset-grouped";
import { SettingsPane } from "../pane";

const STATUS_TONE: Record<WebNotificationPermissionState, Tone> = {
  unsupported: "neutral",
  not_requested: "warning",
  denied: "danger",
  disabled: "neutral",
  enabled: "success",
};

export function NotificationsSettings() {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [preference, setPreference] = useState(readWebNotificationPreference);
  const [busy, setBusy] = useState(false);
  const status = webNotificationPermissionState(preference);

  useEffect(() => {
    const reload = () => setPreference(readWebNotificationPreference());
    window.addEventListener(WEB_NOTIFICATION_PREFERENCE_EVENT, reload);
    window.addEventListener("storage", reload);
    window.addEventListener("focus", reload);
    return () => {
      window.removeEventListener(WEB_NOTIFICATION_PREFERENCE_EVENT, reload);
      window.removeEventListener("storage", reload);
      window.removeEventListener("focus", reload);
    };
  }, []);

  const enable = async () => {
    setBusy(true);
    try {
      await enableWebNotifications();
      setPreference(readWebNotificationPreference());
    } finally {
      setBusy(false);
    }
  };
  const disable = () => {
    disableWebNotifications();
    setPreference(readWebNotificationPreference());
  };

  const canToggle = preference.enabled || (status !== "unsupported" && status !== "denied");

  const notifyFooter = isMobile && canToggle ? (
    <>
      {canToggle ? (
        preference.enabled ? (
          <button type="button" className={BUTTON.secondary} onClick={disable}>
            {t("settingsNotifications.disable")}
          </button>
        ) : (
          <button type="button" className={BUTTON.primary} disabled={busy} onClick={() => void enable()}>
            {busy ? t("settingsNotifications.enabling") : t("settingsNotifications.enable")}
          </button>
        )
      ) : null}
    </>
  ) : undefined;

  if (isMobile) {
    return (
      <SettingsPane footer={notifyFooter}>
        <SectionHeading
          title={t("settingsNotifications.title")}
          description={t("settingsNotifications.description")}
        />
        <WorkflowEmailSettings />
        <InsetGroupedSection caption={t("settingsNotifications.todayTitle")}>
          <InsetGroupedStatic label={t("settingsNotifications.todaySidebar")} />
          <InsetGroupedStatic label={t("settingsNotifications.todayGateCards")} />
          <InsetGroupedStatic label={t("settingsNotifications.todayDecisions")} />
        </InsetGroupedSection>
        <InsetGroupedSection caption={t("settingsNotifications.pageTitle")}>
          <InsetGroupedStatic
            label={t(`settingsNotifications.status.${status}`)}
            subtitle={
              status === "denied"
                ? t("settingsNotifications.permissionDenied")
                : status === "unsupported"
                  ? t("settingsNotifications.permissionUnsupported")
                  : t("settingsNotifications.privacy")
            }
          />
        </InsetGroupedSection>
      </SettingsPane>
    );
  }

  return (
    <SettingsPane>
      <SectionHeading
        title={t("settingsNotifications.title")}
        description={t("settingsNotifications.description")}
      />

      <WorkflowEmailSettings />
      <SettingsCard>
        <CardHeading title={t("settingsNotifications.todayTitle")} />
        <ul className="mt-3 flex flex-col gap-2 text-xs leading-5 text-muted-foreground">
          <li>{t("settingsNotifications.todaySidebar")}</li>
          <li>{t("settingsNotifications.todayGateCards")}</li>
          <li>{t("settingsNotifications.todayDecisions")}</li>
        </ul>
      </SettingsCard>

      <SettingsCard>
        <CardHeading
          title={t("settingsNotifications.pageTitle")}
          description={t("settingsNotifications.pageDescription")}
          action={(
            <ToneBadge tone={STATUS_TONE[status]}>
              {t(`settingsNotifications.status.${status}`)}
            </ToneBadge>
          )}
        />
        <Note tone={status === "denied" ? "danger" : status === "enabled" ? "success" : "neutral"} role="status">
          {status === "denied"
            ? t("settingsNotifications.permissionDenied")
            : status === "unsupported"
              ? t("settingsNotifications.permissionUnsupported")
              : t("settingsNotifications.privacy")}
        </Note>
        {canToggle ? (
          <div className="mt-3 flex justify-end">
            {preference.enabled ? (
              <button type="button" className={BUTTON.secondary} onClick={disable}>
                {t("settingsNotifications.disable")}
              </button>
            ) : (
              <button type="button" className={BUTTON.primary} disabled={busy} onClick={() => void enable()}>
                {busy ? t("settingsNotifications.enabling") : t("settingsNotifications.enable")}
              </button>
            )}
          </div>
        ) : null}
      </SettingsCard>

    </SettingsPane>
  );
}
