import { Dialog } from "@openedbot/browser-ui-kit";
import { formatBytes } from "@openedbot/browser-i18n";
import { useT } from "../lib/i18n";
import { downloadAttachment, type MessageAttachmentChip } from "./attachment-canvas";
import { BUTTON } from "./settings/primitives";

/**
 * Une image du fil, en grand : une boîte modale à 75 % de la vue, au-dessus du
 * fil, pas dans le canevas. Une image se regarde d'un coup d'œil puis se
 * referme (Échap, clic à côté, ✕) ; le canevas reste pour les documents qu'on
 * lit à côté de la conversation.
 *
 * L'image remplit la boîte sans jamais dépasser sa taille réelle.
 *
 * Elle reprend l'URL objet déjà chargée par la vignette : aucun second
 * téléchargement, et la vignette en garde la révocation.
 */
export function ThreadImageDialog({
  attachment,
  url,
  open,
  onClose,
}: {
  attachment: MessageAttachmentChip;
  url: string;
  open: boolean;
  onClose: () => void;
}) {
  const { t, locale } = useT();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={attachment.name}
      description={formatBytes(locale, attachment.bytes)}
      closeLabel={t("common.close")}
      className="h-[75vh] max-h-none w-[75vw] max-w-none"
      bodyClassName="flex items-center justify-center p-3"
      footer={
        <button type="button" className={BUTTON.secondary} onClick={() => void downloadAttachment(attachment)}>
          {t("attachmentCanvas.download")}
        </button>
      }
    >
      {/* Jamais au-delà de sa taille réelle : une petite image agrandie floute
          (un 800x450 étiré ≈ 4x sur Retina). Elle reste centrée, nette. */}
      <img src={url} alt={attachment.name} className="max-h-full max-w-full object-contain" />
    </Dialog>
  );
}
