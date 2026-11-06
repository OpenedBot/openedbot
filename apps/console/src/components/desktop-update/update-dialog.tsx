import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Dialog } from "@openedbot/browser-ui-kit";
import { useT, type MessageKey } from "../../lib/i18n";
import { useClientUpdateRequired } from "../../lib/platform/client-update";
import { nativeUpdates, useNativeUpdateState } from "../../lib/platform/native-updates";
import { BUTTON } from "../settings/primitives";
import { refusalCode, useRunsInProgress, useUpdateDialog } from "./update-hooks";
import { seenVersion } from "./update-model";

/**
 * « Mise à jour prête » : le seul chemin d'un clic vers un redémarrage. La
 * pastille ne redémarre jamais seule (Grok Bot) : le dialogue nomme la
 * version, attend la fin des runs en cours (« Redémarrer quand même » pour ne
 * pas attendre), puis demande à la coque d'installer CETTE version. Si une
 * plus récente est sortie entre-temps, il le dit ; la coque, elle, refuse
 * d'installer une version dépassée ou retirée, et le dialogue explique le refus.
 */
type Step = "confirm" | "waiting" | "installing" | "refused";

const REFUSAL_KEY: Record<string, MessageKey> = {
  UPDATE_SUPERSEDED: "desktopUpdate.refusedSuperseded",
  UPDATE_WITHDRAWN: "desktopUpdate.refusedWithdrawn",
  UPDATE_NOT_READY: "desktopUpdate.refusedNotReady",
  UPDATE_FEED_UNREACHABLE: "desktopUpdate.refusedFeed",
  UPDATE_POPUP_RUNNING: "desktopUpdate.refusedPopup",
};
/** Un nouvel essai a un sens : rien n'a changé du côté du flux. */
const RETRYABLE = new Set(["UPDATE_FEED_UNREACHABLE", "UPDATE_POPUP_RUNNING"]);

export function UpdateDialog() {
  const version = useUpdateDialog((state) => state.version);
  const close = useUpdateDialog((state) => state.close);
  // L'écran « mise à jour requise » remplace l'app et porte sa propre action :
  // le dialogue se ferme sous lui, sans garder de piège de focus invisible.
  const nativeRequired = useNativeUpdateState()?.required != null;
  const apiRequired = useClientUpdateRequired() !== null;
  const required = nativeRequired || apiRequired;
  useEffect(() => {
    if (required) close();
  }, [required, close]);
  if (!version || required) return null;
  return <UpdateDialogBody key={version} seen={version} onClose={close} />;
}

function UpdateDialogBody({ seen, onClose }: { seen: string; onClose: () => void }) {
  const { t, plural } = useT();
  const state = useNativeUpdateState();
  const runs = useRunsInProgress();
  const [step, setStep] = useState<Step>("confirm");
  const [refusal, setRefusal] = useState<string | null>(null);
  const installing = useRef(false);
  const now = seenVersion(seen, state);
  // Une version plus récente déjà prête remplace celle qu'on a vue : le dialogue la nomme.
  const target = now.kind === "replaced" && now.ready ? now.version : seen;
  const canRestart = now.kind === "same" || (now.kind === "replaced" && now.ready);

  const install = useCallback(async (version: string) => {
    const updates = nativeUpdates();
    if (!updates || installing.current) return;
    installing.current = true;
    setStep("installing");
    try {
      // La coque redémarre : cette promesse ne revient en général pas.
      await updates.install(version);
    } catch (error) {
      setRefusal(refusalCode(error) ?? "UPDATE_INSTALL_FAILED");
      setStep("refused");
    } finally {
      installing.current = false;
    }
  }, []);

  // Inconnu (roster illisible) : le clic de l'utilisateur vaut, on n'attend rien qu'on ne voit pas.
  const busy = runs ?? 0;
  useEffect(() => {
    if (step === "waiting" && busy === 0) void install(target);
  }, [step, busy, target, install]);

  const restart = () => {
    if (busy > 0) setStep("waiting");
    else void install(target);
  };
  const dismiss = () => {
    if (step !== "installing") onClose();
  };

  let body: string;
  let note: string | null = null;
  let footer: ReactNode;
  if (step === "installing") {
    body = t("desktopUpdate.restarting");
    footer = null;
  } else if (step === "refused") {
    body = t(REFUSAL_KEY[refusal ?? ""] ?? "desktopUpdate.refusedFailed");
    footer = (
      <>
        <button type="button" className={BUTTON.secondary} onClick={onClose}>{t("desktopUpdate.close")}</button>
        {refusal && RETRYABLE.has(refusal) ? (
          <button type="button" className={BUTTON.primary} onClick={() => void install(target)}>{t("desktopUpdate.retry")}</button>
        ) : null}
      </>
    );
  } else if (step === "waiting") {
    body = plural(busy, { one: t("desktopUpdate.waitingRuns_one", { count: busy }), other: t("desktopUpdate.waitingRuns_other", { count: busy }) });
    note = t("desktopUpdate.waitingHint");
    footer = (
      <>
        <button type="button" className={BUTTON.secondary} onClick={() => setStep("confirm")}>{t("desktopUpdate.cancel")}</button>
        <button type="button" className={BUTTON.primary} onClick={() => void install(target)}>{t("desktopUpdate.restartAnyway")}</button>
      </>
    );
  } else {
    body = t("desktopUpdate.dialogBody", { version: target });
    if (now.kind === "replaced") {
      note = now.ready
        ? t("desktopUpdate.dialogChanged", { version: now.version })
        : now.percent === null
          ? t("desktopUpdate.dialogChangedDownloadingNoTotal", { version: now.version })
          : t("desktopUpdate.dialogChangedDownloading", { version: now.version, percent: now.percent });
    } else if (now.kind === "gone") {
      note = t("desktopUpdate.refusedWithdrawn");
    }
    footer = (
      <>
        <button type="button" className={BUTTON.secondary} onClick={onClose}>{t("desktopUpdate.dialogLater")}</button>
        <button type="button" className={BUTTON.primary} disabled={!canRestart} onClick={restart}>{t("desktopUpdate.dialogRestart")}</button>
      </>
    );
  }

  return (
    <Dialog
      open
      onClose={dismiss}
      role="alertdialog"
      title={t("desktopUpdate.dialogTitle")}
      closeLabel={t("desktopUpdate.close")}
      showClose={step !== "installing"}
      swipeToDismiss={false}
      className="max-w-md"
      footer={footer}
    >
      <div data-desktop-update-dialog={step} className="space-y-3 text-sm">
        <p className="flex items-center gap-2 text-foreground">
          {step === "installing" || step === "waiting" ? <Loader2 aria-hidden className="size-4 shrink-0 animate-spin motion-reduce:animate-none" /> : null}
          <span>{body}</span>
        </p>
        {note ? <p data-desktop-update-note="" className="text-muted-foreground">{note}</p> : null}
      </div>
    </Dialog>
  );
}
