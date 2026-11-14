import { useEffect, useState } from "react";
import { Switch } from "@openedbot/browser-ui-kit";
import { useT } from "../../../lib/i18n";
import { chooseNotchMode, nativeNotch, useNativeNotchState, type NativeNotchMode } from "../../../lib/platform/native-notch";
import { BUTTON, ListRow, ListSection, SectionHeading } from "../../../components/settings/primitives";
import { SettingsPane } from "../pane";

/** How long « Regardez en haut de votre écran » stays displayed: the two loops of the replayed demonstration. */
const REPLAY_NOTE_MS = 25_000;

/**
 * Settings › Notch (Tauri app on Mac): show openedbot in the notch
 * (the window and the notch), hide the window when the notch is active
 * (the notch alone), replay the demonstration without changing that choice. The same
 * choice as the Dock menu and as the first-sign-in sheet,
 * kept by the shell (`notch.rs`).
 */
export function NotchSettings() {
  const { t } = useT();
  const state = useNativeNotchState();
  const notch = nativeNotch();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [replay, setReplay] = useState<"idle" | "playing" | "failed">("idle");

  useEffect(() => {
    if (replay !== "playing") return;
    const timer = window.setTimeout(() => setReplay("idle"), REPLAY_NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [replay]);

  const heading = <SectionHeading title={t("settingsSidebar.notch")} description={t("desktopNotch.settingsDescription")} />;
  if (!notch || (state && !state.supported)) {
    return (
      <SettingsPane>
        {heading}
        <p data-notch-status="not-mac" className="text-sm text-muted-foreground">{t("desktopNotch.settingsNotMac")}</p>
      </SettingsPane>
    );
  }

  const available = state?.available ?? false;
  const on = state !== null && state.mode !== "window";
  const alone = state?.mode === "popup";
  const set = async (mode: NativeNotchMode) => {
    setBusy(true);
    setFailed(false);
    try {
      await chooseNotchMode(mode);
    } catch (error) {
      console.warn("[openedbot] notch mode refused", error);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const playDemo = async () => {
    try {
      await notch.playDemo();
      setReplay("playing");
    } catch (error) {
      console.warn("[openedbot] notch demo refused", error);
      setReplay("failed");
    }
  };

  return (
    <SettingsPane>
      {heading}
      {state && !available ? <p data-notch-status="unavailable" className="text-sm text-muted-foreground">{t("desktopNotch.settingsUnavailable")}</p> : null}
      <ListSection title={t("desktopNotch.settingsShowTitle")}>
        <ListRow label={t("desktopNotch.settingsShow")} description={t(state?.cameraHousing === false ? "desktopNotch.settingsShowHintMenuBar" : "desktopNotch.settingsShowHintCamera")}>
          <Switch
            aria-label={t("desktopNotch.settingsShow")}
            data-notch-setting="show"
            checked={on}
            disabled={!available || busy}
            onCheckedChange={(enabled) => void set(enabled ? "both" : "window")}
          />
        </ListRow>
        <ListRow label={t("desktopNotch.settingsHideWindow")} description={t("desktopNotch.settingsHideWindowHint")}>
          <Switch
            aria-label={t("desktopNotch.settingsHideWindow")}
            data-notch-setting="hide-window"
            checked={alone}
            disabled={!available || !on || busy}
            onCheckedChange={(enabled) => void set(enabled ? "popup" : "both")}
          />
        </ListRow>
        {failed ? <ListRow label=""><span role="alert" className="text-destructive-text">{t("desktopNotch.settingsFailed")}</span></ListRow> : null}
      </ListSection>
      <ListSection title={t("desktopNotch.settingsDemoTitle")}>
        <ListRow
          label={t("desktopNotch.settingsReplay")}
          description={
            replay === "playing"
              ? t("desktopNotch.settingsReplayPlaying")
              : replay === "failed" || (state !== null && available && !state.demoSupported)
                ? t("desktopNotch.settingsReplayUnavailable")
                : t("desktopNotch.settingsReplayHint")
          }
        >
          <button type="button" className={BUTTON.secondary} data-notch-replay="" disabled={!available || !state?.demoSupported} onClick={() => void playDemo()}>
            {t("desktopNotch.settingsReplay")}
          </button>
        </ListRow>
      </ListSection>
    </SettingsPane>
  );
}
