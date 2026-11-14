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
import { ThreadImageDialog } from "./thread-image-dialog";

/**
 * An attachment OF THE THREAD: the file itself, not the memory of it.
 *
 * Its bytes live in `message_attachments` and are served by
 * `GET /api/attachments/:id`; one loads them by an authenticated `fetch` then
 * `URL.createObjectURL`, never by a token URL: the header stays the only
 * authentication path outside the SSE stream. The object URL is REVOKED on
 * unmount: without that, scrolling a long thread would keep every image in
 * memory until the window closes.
 *
 * An image shows as a thumbnail: its CLICK opens it large in a modal
 * at 75% of the view (`thread-image-dialog.tsx`), not in the canvas.
 * A document stays a named chip: its click opens the reading canvas beside
 * the thread (`attachment-canvas.tsx`). Outside a canvas (no provider
 * above), it falls back to download: a control that does nothing
 * would be worse.
 *
 * Nothing is loaded for a document until one opens it: showing its
 * name does not require reading its content.
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
  const [viewing, setViewing] = useState(false);

  /**
   * Without an `id`, there is NOTHING to open: this message's file was never
   * stored (a message from before files were stored). The chip then names
   * itself, without pretending to be clickable: it is the « absent, ou
   * actif » principle applied to data that is missing, not to a missing function.
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
      <figure data-thread-layout-pending={!url ? "" : undefined} className="overflow-hidden rounded-xl border border-border/60 bg-muted/40">
        {url ? (
          <button
            type="button"
            onClick={() => setViewing(true)}
            aria-label={t("threadTimeline.attachmentOpen", { name: attachment.name })}
            className="block outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <img src={url} alt={attachment.name} className="max-h-64 max-w-64 object-contain" />
          </button>
        ) : (
          // Same ceiling as the `img` (`max-h-64`): `size-32` let a
          // portrait receipt grow by 128 px and drop the pin via `onScroll`.
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
        {url ? <ThreadImageDialog attachment={attachment} url={url} open={viewing} onClose={() => setViewing(false)} /> : null}
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
