import { memo, useLayoutEffect, useState } from "react";
import { Loader2, Paperclip } from "lucide-react";
import { formatBytes } from "@openedbot/browser-i18n";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import {
  downloadAttachment,
  useAttachmentCanvas,
  type MessageAttachmentChip,
} from "./attachment-canvas";

/**
 * Une pièce jointe DU FIL : le fichier lui-même, pas son souvenir.
 *
 * Ses octets vivent dans `message_attachments` et sont servis par
 * `GET /api/attachments/:id` ; on les charge par `fetch` authentifié puis
 * `URL.createObjectURL`, jamais par une URL à jeton : l'en-tête reste le seul
 * chemin d'authentification hors du flux SSE. L'URL objet est RÉVOQUÉE au
 * démontage : sans ça, faire défiler un long fil garderait chaque image en
 * mémoire jusqu'à la fermeture de la fenêtre.
 *
 * Une image se montre en vignette, un document reste une puce nommée. Dans les
 * deux cas, le CLIC ouvre le canevas de lecture à côté du fil
 * (`attachment-canvas.tsx`) : c'est là qu'on lit un fichier, pas dans une bulle
 * de conversation. Hors canevas (aucun fournisseur au-dessus), le clic retombe
 * sur le téléchargement : un contrôle qui ne fait rien serait pire.
 *
 * Rien n'est chargé pour un document tant qu'on ne l'ouvre pas : afficher son
 * nom n'exige pas de lire son contenu.
 */
export const AttachmentTile = memo(function AttachmentTile({
  attachment,
}: {
  attachment: MessageAttachmentChip;
}) {
  const { t, locale } = useT();
  const canvas = useAttachmentCanvas();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  /**
   * Sans `id`, il n'y a RIEN à ouvrir : le fichier de ce message n'a jamais
   * été rangé (message antérieur au rangement des fichiers). La puce se nomme
   * alors, sans se prétendre cliquable : c'est le principe « absent, ou
   * actif » appliqué à une donnée qui manque, pas à une fonction absente.
   */
  const readable = Boolean(attachment.id);
  const activate = () => {
    if (!attachment.id) return;
    if (canvas) canvas.open(attachment);
    else void downloadAttachment(attachment);
  };

  useLayoutEffect(() => {
    if (attachment.kind !== "image" || !attachment.id) return;
    const attachmentId = attachment.id;
    let objectUrl: string | null = null;
    let cancelled = false;
    void api
      .attachment(attachmentId)
      .then((blob) => {
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
  }, [attachment.id, attachment.kind]);

  if (!readable) {
    return (
      <span className="flex max-w-56 items-center gap-1.5 rounded-lg border border-border/60 bg-muted/40 px-2 py-1 text-xs">
        <Paperclip className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate" title={attachment.name}>
          {attachment.name}
        </span>
        <span className="shrink-0 text-muted-foreground">{formatBytes(locale, attachment.bytes)}</span>
      </span>
    );
  }

  if (attachment.kind === "image" && !failed) {
    return (
      <figure className="overflow-hidden rounded-xl border border-border/60 bg-muted/40">
        {url ? (
          <button
            type="button"
            onClick={activate}
            aria-label={t("threadTimeline.attachmentOpen", { name: attachment.name })}
            className="block outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <img src={url} alt={attachment.name} className="max-h-64 max-w-64 object-contain" />
          </button>
        ) : (
          // Même plafond que l'`img` (`max-h-64`) : `size-32` laissait un
          // reçu portrait grandir de 128 px et lâcher le pin via `onScroll`.
          <div className="flex h-64 w-64 items-center justify-center">
            <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
          </div>
        )}
        <figcaption className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
          <span className="truncate" title={attachment.name}>
            {attachment.name}
          </span>
          <span className="shrink-0">{formatBytes(locale, attachment.bytes)}</span>
        </figcaption>
      </figure>
    );
  }

  return (
    <button
      type="button"
      onClick={activate}
      title={t("threadTimeline.attachmentOpen", { name: attachment.name })}
      className="flex max-w-56 items-center gap-1.5 rounded-lg border border-border/60 bg-muted/40 px-2 py-1 text-xs outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Paperclip className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">{attachment.name}</span>
      <span className="shrink-0 text-muted-foreground">{formatBytes(locale, attachment.bytes)}</span>
    </button>
  );
});
