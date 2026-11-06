import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useT, type MessageKey } from "../../lib/i18n";
import { nativeBridge } from "../../lib/platform";
import { desktopDownloadUrl, type ClientUpdateState } from "../../lib/platform/client-update";
import { nativeUpdates, useNativeUpdateState, type NativeUpdateRequirement } from "../../lib/platform/native-updates";
import { BUTTON } from "../settings/primitives";
import { refusalCode, useRunsInProgress } from "./update-hooks";
import { downloadPercent } from "./update-model";

const REASON_KEY: Record<NativeUpdateRequirement["reason"], MessageKey> = {
  api: "desktopUpdate.requiredBodyApi",
  minimumVersion: "desktopUpdate.requiredBodyMinimum",
  buildAge: "desktopUpdate.requiredBodyAge",
};

/** Stands for « a check was already running at the click »: any return to rest ends it. */
const CHECK_UNDER_WAY = "\u0000check";

/**
 * L'écran « Mise à jour requise » de l'app Tauri : l'API refuse cette version
 * (426) ou le manifeste fixe un plancher que ce build ne tient pas
 * (`min_version`, `max_age_days`). Il remplace l'app entière, comme l'écran
 * du 426 d'Electron (`client-update-required.tsx`), mais propose d'installer
 * par la coque : « Mettre à jour maintenant » attend la fin du
 * téléchargement s'il le faut (progression affichée), avertit si des runs
 * sont en cours, puis installe et redémarre. Si la coque n'y arrive pas, le
 * lien de la page de téléchargement reste là. Pas d'attente de l'inactivité :
 * le clic suffit.
 */
export function DesktopUpdateRequired({ api }: { api: ClientUpdateState | null }) {
  const { t, plural, locale } = useT();
  const state = useNativeUpdateState();
  const runs = useRunsInProgress();
  const [wanted, setWanted] = useState(false);
  const [runsAccepted, setRunsAccepted] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [openFailed, setOpenFailed] = useState(false);
  /** `lastCheck` when the click asked for a check; `undefined` when none is pending. */
  const [checkFrom, setCheckFrom] = useState<string | null | undefined>(undefined);
  /** The check answered, and the feed offers nothing to install. */
  const [nothing, setNothing] = useState(false);
  const action = useRef<HTMLButtonElement>(null);
  useEffect(() => action.current?.focus(), []);

  const phase = state?.phase ?? null;
  const ready = phase?.status === "ready" ? phase.version : null;
  const reason = state?.required?.reason ?? "api";
  const minimum = state?.required?.minimum ?? api?.minVersion ?? null;
  const version = nativeBridge()?.shell.version ?? api?.version ?? null;
  const busyRuns = runs ?? 0;
  const askRuns = wanted && ready !== null && busyRuns > 0 && !runsAccepted;

  const install = useCallback(async (target: string) => {
    const updates = nativeUpdates();
    if (!updates) return;
    setInstalling(true);
    try {
      await updates.install(target);
    } catch (error) {
      setRefused(refusalCode(error) ?? "UPDATE_INSTALL_FAILED");
      setWanted(false);
    } finally {
      setInstalling(false);
    }
  }, []);

  useEffect(() => {
    if (wanted && ready && !installing && (busyRuns === 0 || runsAccepted)) void install(ready);
  }, [wanted, ready, installing, busyRuns, runsAccepted, install]);

  // A check that ends in error, even the same error as before the click
  // (the shell publishes each state it reaches, so a new one has arrived).
  const stateAtClick = useRef(state);
  useEffect(() => {
    if (phase?.status === "error" && state !== stateAtClick.current) setWanted(false);
  }, [phase?.status, state]);

  // A check that ends back at rest found nothing newer (or no feed at all):
  // the button comes back and the download page is offered.
  const lastCheck = state?.lastCheck ?? null;
  useEffect(() => {
    if (checkFrom === undefined || phase?.status !== "idle" || lastCheck === checkFrom) return;
    setCheckFrom(undefined);
    setWanted(false);
    setNothing(true);
  }, [checkFrom, phase?.status, lastCheck]);

  const start = () => {
    stateAtClick.current = state;
    setRefused(null);
    setNothing(false);
    setWanted(true);
    const busy = phase?.status === "checking" || phase?.status === "available" || phase?.status === "downloading" || phase?.status === "installing";
    if (!ready) {
      // A check already under way counts too: if it ends with nothing newer, the button comes back.
      setCheckFrom(busy ? CHECK_UNDER_WAY : lastCheck);
      if (!busy) void nativeUpdates()?.check().catch(() => undefined);
    }
  };

  const download = desktopDownloadUrl(locale === "fr" ? "fr" : "en");
  const openDownload = () => {
    const bridge = nativeBridge();
    if (!bridge) return;
    bridge.openExternal(download).catch(() => setOpenFailed(true));
  };
  const failed = refused !== null || nothing || phase?.status === "error" || state?.lastError != null;

  let label = t("desktopUpdate.requiredUpdateNow");
  if (installing || phase?.status === "installing") label = t("desktopUpdate.restarting");
  else if (wanted && phase?.status === "downloading") {
    const percent = downloadPercent(phase);
    label = percent === null ? t("desktopUpdate.requiredPreparing") : t("desktopUpdate.requiredDownloading", { percent });
  } else if (wanted && !ready) label = t("desktopUpdate.requiredPreparing");
  const busy = installing || phase?.status === "installing" || (wanted && !askRuns);

  return (
    <div role="alertdialog" aria-modal="true" aria-labelledby="desktop-update-required-title" data-desktop-update-required={reason} className="fixed inset-0 z-[1000] flex items-center justify-center bg-background p-6">
      <div className="flex max-w-md flex-col gap-4 text-center">
        <h1 id="desktop-update-required-title" className="text-xl font-semibold text-text-primary">{t("desktopUpdate.requiredTitle")}</h1>
        <p className="text-text-secondary">{t(REASON_KEY[reason], { minimum: minimum ?? "" })}</p>
        {version ? <p className="text-sm text-text-secondary">{t("desktopUpdate.requiredInstalled", { version })}</p> : null}
        {askRuns ? (
          <div className="flex flex-col gap-2 rounded-xl bg-warn-soft p-3 text-sm text-warn-700">
            <p>{plural(busyRuns, { one: t("desktopUpdate.requiredRuns_one", { count: busyRuns }), other: t("desktopUpdate.requiredRuns_other", { count: busyRuns }) })}</p>
            <button type="button" className={BUTTON.secondary} onClick={() => setRunsAccepted(true)}>{t("desktopUpdate.requiredUpdateAnyway")}</button>
          </div>
        ) : (
          <button ref={action} type="button" className={BUTTON.primary} disabled={busy} onClick={start}>
            {busy ? <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : null}
            {label}
          </button>
        )}
        {failed ? (
          <div data-desktop-update-fallback="" className="flex flex-col gap-2 text-sm text-text-secondary">
            <p>{refused === "UPDATE_SUPERSEDED" ? t("desktopUpdate.refusedSuperseded") : nothing ? t("desktopUpdate.requiredNothing") : t("desktopUpdate.requiredFallback")}</p>
            <button type="button" className={BUTTON.secondary} onClick={openDownload}>{t("clientUpdate.download")}</button>
            {openFailed ? <p className="select-all">{t("clientUpdate.linkHint", { url: download })}</p> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
