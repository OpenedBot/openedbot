import { useEffect, useRef, useState } from "react";
import { Dialog } from "@openedbot/browser-ui-kit";
import { useT } from "../../lib/i18n";
import { chooseNotchMode, useNativeNotchState, type NativeNotchMode } from "../../lib/platform/native-notch";
import { BUTTON } from "../settings/primitives";
import { NotchPreview } from "./notch-preview";

/**
 * The notch choice, on first sign-in on Mac.
 * The shell opens it (`onboarding` in the notch state) once the
 * session is open, as long as nothing has been chosen, and plays at the same time the
 * demonstration in the notch; with no demonstration possible, a drawn
 * preview replaces it. « Garder l'encoche » (the default button) keeps the
 * window and the notch; « Pas maintenant » (or Escape) keeps the window
 * alone. Closing the app without answering keeps nothing: the question comes back on
 * the next launch. The shell closes the sheet once the choice is kept.
 */
export function NotchOnboarding() {
  const state = useNativeNotchState();
  if (!state?.onboarding) return null;
  return <NotchOnboardingSheet demo={state.demoSupported} camera={state.cameraHousing} />;
}

export function NotchOnboardingSheet({ demo, camera }: { demo: boolean; camera: boolean }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // Escape answers « Pas maintenant »; a click beside the sheet answers nothing: the box
  // calls `onClose` in both cases, so the key is noted before it (capture phase).
  const escaped = useRef(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") escaped.current = true;
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  const choose = async (mode: NativeNotchMode) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await chooseNotchMode(mode);
    } catch (error) {
      console.warn("[openedbot] notch choice refused", error);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={() => {
        if (!escaped.current) return;
        escaped.current = false;
        void choose("window");
      }}
      title={t("desktopNotch.sheetTitle")}
      showClose={false}
      swipeToDismiss={false}
      className="max-w-md"
      footer={
        <>
          <button type="button" className={BUTTON.secondary} disabled={busy} data-notch-choice="window" onClick={() => void choose("window")}>
            {t("desktopNotch.notNow")}
          </button>
          <button type="button" className={BUTTON.primary} disabled={busy} data-dialog-autofocus="" data-notch-choice="both" onClick={() => void choose("both")}>
            {t("desktopNotch.keep")}
          </button>
        </>
      }
    >
      <div data-notch-onboarding={demo ? "demo" : "preview"} className="space-y-3 text-sm">
        <p className="text-foreground">{t(camera ? "desktopNotch.sheetBodyCamera" : "desktopNotch.sheetBodyMenuBar")}</p>
        <p className="font-medium text-foreground">{t(demo ? "desktopNotch.sheetDemo" : "desktopNotch.sheetPreview")}</p>
        {demo ? null : <NotchPreview />}
        {failed ? <p role="alert" className="text-destructive-text">{t("desktopNotch.chooseFailed")}</p> : null}
        <p className="text-xs text-muted-foreground">{t("desktopNotch.footnote")}</p>
      </div>
    </Dialog>
  );
}
