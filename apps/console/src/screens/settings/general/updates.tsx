import { Switch } from "@openedbot/browser-ui-kit";
import { useT, type MessageKey } from "../../../lib/i18n";
import { nativeBridge } from "../../../lib/platform";
import { nativeUpdates, useNativeUpdateState, type NativeUpdateErrorCode, type NativeUpdateState } from "../../../lib/platform/native-updates";
import { BUTTON, ListRow, ListSection, SectionHeading } from "../../../components/settings/primitives";
import { openUpdateDialog } from "../../../components/desktop-update/update-hooks";
import { downloadPercent } from "../../../components/desktop-update/update-model";
import { SettingsPane } from "../pane";

const ERROR_KEY: Record<NativeUpdateErrorCode, MessageKey> = {
  FEED_UNREACHABLE: "desktopUpdate.errorFeed",
  DOWNLOAD_FAILED: "desktopUpdate.errorDownload",
  SIGNATURE_REFUSED: "desktopUpdate.errorSignature",
  POPUP_STILL_RUNNING: "desktopUpdate.errorPopup",
  INSTALL_FAILED: "desktopUpdate.errorInstall",
  TRANSLOCATED: "desktopUpdate.errorTranslocated",
};

export function statusText(state: NativeUpdateState, t: ReturnType<typeof useT>["t"]): string {
  const { phase } = state;
  switch (phase.status) {
    case "idle":
      return t("desktopUpdate.statusIdle");
    case "checking":
      return t("desktopUpdate.statusChecking");
    case "available":
      return t("desktopUpdate.statusAvailable", { version: phase.version });
    case "downloading": {
      const percent = downloadPercent(phase);
      return percent === null ? t("desktopUpdate.statusDownloadingNoTotal", { version: phase.version }) : t("desktopUpdate.statusDownloading", { version: phase.version, percent });
    }
    case "ready":
      return t("desktopUpdate.statusReady", { version: phase.version });
    case "installing":
      return t("desktopUpdate.statusInstalling", { version: phase.version });
    case "error":
      return t("desktopUpdate.statusError");
  }
}

/**
 * Réglages › Mises à jour (app Tauri) : la version installée, où en est la
 * mise à jour, « Rechercher », le redémarrage quand une version est prête,
 * l'installation au repos (activée par défaut, gardée dans les préférences de
 * la coque) et la dernière erreur. C'est le seul endroit où une erreur se lit :
 * la barre latérale n'en montre aucune.
 */
export function UpdatesSettings() {
  const { t, locale } = useT();
  const state = useNativeUpdateState();
  const updates = nativeUpdates();
  const version = nativeBridge()?.shell.version ?? null;
  if (!updates) {
    return (
      <SettingsPane>
        <SectionHeading title={t("settingsSidebar.updates")} description={t("desktopUpdate.settingsWebOnly")} />
      </SettingsPane>
    );
  }
  const phase = state?.phase ?? null;
  const ready = phase?.status === "ready" ? phase.version : null;
  const busy = phase?.status === "checking" || phase?.status === "available" || phase?.status === "downloading" || phase?.status === "installing";
  const lastCheck = state?.lastCheck ? new Date(state.lastCheck).toLocaleString(locale === "fr" ? "fr-FR" : "en-GB", { dateStyle: "medium", timeStyle: "short" }) : t("desktopUpdate.settingsNeverChecked");
  const error = state?.lastError ?? (phase?.status === "error" ? phase.code : null);

  return (
    <SettingsPane>
      <SectionHeading title={t("settingsSidebar.updates")} description={t("desktopUpdate.settingsDescription")} />
      <ListSection title={t("desktopUpdate.settingsVersionTitle")}>
        <ListRow label={t("desktopUpdate.settingsInstalled")} value={version ?? "—"} mono />
        <ListRow label={t("desktopUpdate.settingsStatus")} value={<span data-desktop-update-status={phase?.status ?? "unknown"}>{state ? statusText(state, t) : "…"}</span>} />
        <ListRow label={t("desktopUpdate.settingsLastCheck")} value={lastCheck} />
        {error ? <ListRow label={t("desktopUpdate.settingsLastError")} value={<span data-desktop-update-error={error} className="text-destructive-text">{t(ERROR_KEY[error])}</span>} /> : null}
        <ListRow label="">
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={BUTTON.secondary} disabled={busy} onClick={() => void updates.check()}>{t("desktopUpdate.settingsCheck")}</button>
            {ready ? <button type="button" className={BUTTON.primary} onClick={() => openUpdateDialog(ready)}>{t("desktopUpdate.settingsRestart")}</button> : null}
          </div>
        </ListRow>
      </ListSection>
      <ListSection title={t("desktopUpdate.settingsAutoTitle")}>
        <ListRow label={t("desktopUpdate.settingsAutoInstall")} description={t("desktopUpdate.settingsAutoInstallHint")}>
          <Switch
            aria-label={t("desktopUpdate.settingsAutoInstall")}
            checked={state?.autoInstall ?? true}
            disabled={!state}
            onCheckedChange={(enabled) => void updates.setAutoInstall(enabled)}
          />
        </ListRow>
      </ListSection>
    </SettingsPane>
  );
}
