import { useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../lib/i18n";
import { nativeBridge } from "../lib/platform";
import { desktopDownloadUrl, useClientUpdateRequired } from "../lib/platform/client-update";
import { BUTTON } from "./settings/primitives";

/**
 * L'écran qui remplace la console quand l'API a répondu `426
 * CLIENT_UPDATE_REQUIRED` : l'app de bureau est trop vieille pour l'API.
 * Rien d'autre ne marcherait, l'écran ne propose donc qu'une chose. Si la
 * coque refuse d'ouvrir le navigateur, l'adresse reste lisible en clair.
 *
 * Il remplace l'arbre de l'app au lieu de le couvrir : un menu ou une
 * modale ouverts gardaient sinon leur piège de focus et le
 * `pointer-events: none` posé sur `body`, et le bouton de téléchargement
 * devenait inatteignable. Démontés avec l'app, ils libèrent tout.
 */
export function ClientUpdateGate({ children }: { children: ReactNode }) {
  const update = useClientUpdateRequired();
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
