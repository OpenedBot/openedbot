import { useEffect, useRef, useState } from "react";
import { Dialog } from "@openedbot/browser-ui-kit";
import { useT } from "../../lib/i18n";
import { chooseNotchMode, useNativeNotchState, type NativeNotchMode } from "../../lib/platform/native-notch";
import { BUTTON } from "../settings/primitives";
import { NotchPreview } from "./notch-preview";

/**
 * Le choix de l'encoche, à la première connexion sur Mac (ADR 0001, 4.3.7).
 * La coque l'ouvre (`onboarding` dans l'état de l'encoche) une fois la
 * session ouverte, tant que rien n'a été choisi, et joue en même temps la
 * démonstration dans l'encoche ; sans démonstration possible, un aperçu
 * dessiné la remplace. « Garder l'encoche » (le bouton par défaut) garde la
 * fenêtre et l'encoche ; « Pas maintenant » (ou Échap) garde la fenêtre
 * seule. Fermer l'app sans répondre ne garde rien : la question revient au
 * lancement suivant. La coque referme la feuille une fois le choix gardé.
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
  // Échap répond « Pas maintenant » ; un clic à côté de la feuille ne répond rien : la boîte
  // appelle `onClose` dans les deux cas, la touche est donc notée avant elle (phase de capture).
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
