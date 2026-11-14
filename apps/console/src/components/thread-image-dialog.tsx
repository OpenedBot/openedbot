import { Dialog } from "@openedbot/browser-ui-kit";
import { formatBytes } from "@openedbot/browser-i18n";
import { useT } from "../lib/i18n";
import { downloadAttachment, type MessageAttachmentChip } from "./attachment-canvas";
import { BUTTON } from "./settings/primitives";

/**
 * An image from the thread, large: a modal at 75% of the view, above the
 * thread, not in the canvas. An image is looked at in a glance then
 * closes (Escape, click beside, ✕); the canvas stays for the documents one
 * reads beside the conversation.
 *
 * The image fills the dialog without ever exceeding its real size.
 *
 * It reuses the object URL the thumbnail already loaded: no second
 * download, and the thumbnail keeps its revocation.
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
      {/* Never past its real size: a small image enlarged blurs
          (an 800x450 stretched ≈ 4x on Retina). It stays centred, sharp. */}
      <img src={url} alt={attachment.name} className="max-h-full max-w-full object-contain" />
    </Dialog>
  );
}
