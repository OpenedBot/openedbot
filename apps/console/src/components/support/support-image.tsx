import { useEffect, useState } from "react";
import type { SupportAttachmentDto } from "@openedbot/contracts-api";
import { cn } from "@openedbot/browser-ui-kit";
import { API_ORIGIN } from "../../lib/api";
import { useT } from "../../lib/i18n";

/**
 * Une capture d'un fil de support, affichée.
 *
 * Pourquoi un `fetch` puis une URL d'objet, et pas un simple `src` : la route
 * qui sert l'image est GARDÉE. Un visiteur sans compte présente son jeton dans
 * un EN-TÊTE, et un `<img src>` ne sait pas poser d'en-tête. Un opérateur
 * connecté présente son cookie, mais `SameSite=Lax` ne le joint pas à une
 * requête d'image vers une autre origine (`API_ORIGIN`). Les deux portes
 * n'existent donc que pour `fetch`.
 *
 * Le jeton ne passe JAMAIS dans l'URL, ce qui serait l'autre façon de faire
 * marcher `<img>` : il finirait dans les journaux du serveur, dans
 * l'historique et dans le `Referer`.
 *
 * L'URL d'objet est révoquée au démontage : sans cela, chaque ouverture du
 * panneau garderait une copie des images en mémoire jusqu'au rechargement.
 */
export function SupportImage({
  attachment,
  token,
  className,
}: {
  attachment: SupportAttachmentDto;
  /** Le jeton du fil, ou `null` quand c'est la session qui ouvre la porte. */
  token: string | null;
  className?: string;
}) {
  const { t } = useT();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setFailed(false);
    void fetch(`${API_ORIGIN}/api/support/attachments/${attachment.id}`, {
      headers: token ? { "X-OpenedBot-Support-Token": token } : {},
      credentials: "include",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id, token]);

  if (failed) {
    return (
      <p className="text-[11px] text-muted-foreground" role="status">
        {t("support.attachmentFailed", { name: attachment.name })}
      </p>
    );
  }
  return (
    <a
      // Ouvrir en grand, c'est ouvrir l'URL d'objet : elle vit dans cet onglet
      // et ne traverse pas le réseau une seconde fois.
      href={url ?? undefined}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={t("support.attachmentOpen", { name: attachment.name })}
      className={cn(
        "block max-w-[15rem] overflow-hidden rounded-xl border border-border/60 bg-muted",
        !url && "h-24 w-40 animate-pulse",
        className,
      )}
    >
      {url ? (
        <img src={url} alt={attachment.name} className="block h-auto w-full object-cover" />
      ) : null}
    </a>
  );
}
