import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../lib/i18n";
import { nativeBridge } from "../lib/platform";
import { desktopDownloadUrl, useClientUpdateRequired } from "../lib/platform/client-update";
import { useNativeUpdateRequired } from "../lib/platform/native-updates";
import { DesktopUpdateRequired } from "./desktop-update/entry";
import { BUTTON } from "./settings/primitives";

/**
 * The screen that replaces the console when the API answered `426
 * CLIENT_UPDATE_REQUIRED`: the desktop app is too old for the API.
 * Nothing else would work, so the screen offers only one thing. If the
 * shell refuses to open the browser, the address stays readable in the clear.
 *
 * It replaces the app tree instead of covering it: an open menu or
 * modal would otherwise keep their focus trap and the
 * `pointer-events: none` set on `body`, and the download button
 * would become unreachable. Unmounted with the app, they release everything.
 *
 * In the Tauri app, two triggers lead to the shell's screen, which knows how to
 * install the update (`desktop-update/update-required.tsx`): this 426, or
 * the update manifest's floor (`required` on the shell's state).
 * On the web, `DesktopUpdateRequired` is `null` and only the 426 counts.
 */
export function ClientUpdateGate({ children }: { children: ReactNode }) {
  const update = useClientUpdateRequired();
  const nativeRequired = useNativeUpdateRequired();
  if (DesktopUpdateRequired && (update || nativeRequired)) {
    return (
      <Suspense fallback={<div className="fixed inset-0 z-[1000] bg-background" />}>
        <DesktopUpdateRequired api={update} />
      </Suspense>
    );
  }
  return update ? <ClientUpdateRequired update={update} /> : children;
}

function ClientUpdateRequired({ update }: { update: NonNullable<ReturnType<typeof useClientUpdateRequired>> }) {
  const { t, locale } = useT();
  const [openFailed, setOpenFailed] = useState(false);
  const download = useRef<HTMLButtonElement>(null);
  useEffect(() => download.current?.focus(), []);
  const url = desktopDownloadUrl(locale === "fr" ? "fr" : "en");
  const open = () => {
    const bridge = nativeBridge();
    if (!bridge) {
      window.open(url, "_blank", "noopener");
      return;
    }
    bridge.openExternal(url).catch(() => setOpenFailed(true));
  };
  return (
    <div role="alertdialog" aria-modal="true" aria-labelledby="client-update-title" className="fixed inset-0 z-[1000] flex items-center justify-center bg-background p-6">
      <div className="flex max-w-md flex-col gap-4 text-center">
        <h1 id="client-update-title" className="text-xl font-semibold text-text-primary">{t("clientUpdate.title")}</h1>
        <p className="text-text-secondary">{t("clientUpdate.body")}</p>
        {update.version && update.minVersion
          ? <p className="text-sm text-text-secondary">{t("clientUpdate.bodyVersions", { version: update.version, minVersion: update.minVersion })}</p>
          : null}
        <button ref={download} type="button" className={BUTTON.primary} onClick={open}>{t("clientUpdate.download")}</button>
        {openFailed ? <p className="text-sm text-text-secondary select-all">{t("clientUpdate.linkHint", { url })}</p> : null}
      </div>
    </div>
  );
}
