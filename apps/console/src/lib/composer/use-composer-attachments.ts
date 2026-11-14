import { useLayoutEffect, useRef, useState } from "react";
import { ATTACHMENT_LIMITS, type MessageAttachmentInput } from "@openedbot/conversation/domain/attachments";
import { prepareAttachments, type AttachmentError } from "./attachments";
import { attachmentKindFor } from "./attachments-file";

type PendingTile = { batch: number; index: number; name: string; image?: string; progress: number };

/** Owns concurrent file reads for one composer draft, including their preview lifetime. */
export function useComposerAttachments({
  attachments,
  onAttachmentsChange,
  attachmentScope,
  disabled,
  sending,
}: {
  attachments: readonly MessageAttachmentInput[];
  onAttachmentsChange?: (next: MessageAttachmentInput[]) => void;
  attachmentScope?: string;
  disabled: boolean;
  sending: boolean;
}) {
  const [preparing, setPreparing] = useState(false);
  const [errors, setErrors] = useState<AttachmentError[]>([]);

  /**
   * The tiles being read. The progress is the `FileReader`'s
   * (`prepareAttachments`), never a clock: a file that emits none
   * jumps from 0 to done. They leave the strip when the batch is handed to
   * the screen, which then puts the real attachments in their place.
   */
  const [pending, setPending] = useState<PendingTile[]>([]);

  const attachmentState = useRef({ attachments, onAttachmentsChange });
  useLayoutEffect(() => {
    attachmentState.current = { attachments, onAttachmentsChange };
  }, [attachments, onAttachmentsChange]);
  const nextBatch = useRef(0);
  const batches = useRef(new Map<number, string[]>());
  useLayoutEffect(() => {
    setPending([]);
    setPreparing(false);
    setErrors([]);
    return () => {
      for (const previews of batches.current.values()) {
        for (const url of previews) URL.revokeObjectURL(url);
      }
      batches.current.clear();
    };
  }, [attachmentScope]);

  const addFiles = async (files: readonly File[]) => {
    if (!files.length || !onAttachmentsChange || disabled || sending) return;
    const batch = nextBatch.current++;
    if (!batches.current.size) setErrors([]);
    const previews: string[] = [];
    batches.current.set(batch, previews);
    setPreparing(true);
    try {
      const tiles = files.flatMap((file, index) => {
        const kind = attachmentKindFor(file);
        if (!kind) return [];
        let image: string | undefined;
        if (kind === "image" && typeof URL.createObjectURL === "function") {
          image = URL.createObjectURL(file);
          previews.push(image);
        }
        return [{ batch, index, name: file.name, image, progress: 0 }];
      });
      setPending((current) => [...current, ...tiles]);
      // Validate the shared count when committing, against the current draft:
      // other batches can finish and existing attachments can be removed meanwhile.
      const result = await prepareAttachments(files, 0, (index, fraction) => {
        if (!batches.current.has(batch)) return;
        setPending((tiles) =>
          tiles.map((tile) => (tile.batch === batch && tile.index === index
            ? { ...tile, progress: fraction * 100 } : tile)),
        );
      });
      if (!batches.current.has(batch)) return;
      const current = attachmentState.current;
      const available = Math.max(0, ATTACHMENT_LIMITS.maxCount - current.attachments.length);
      const accepted = result.attachments.slice(0, available);
      if (accepted.length && current.onAttachmentsChange) {
        const next = [...current.attachments, ...accepted];
        // Synchronize before React commits so two completions in one tick compose.
        attachmentState.current = { ...current, attachments: next };
        current.onAttachmentsChange(next);
      }
      setErrors((errors) => [
        ...errors,
        ...result.errors,
        ...(accepted.length < result.attachments.length ? [{ code: "too-many" as const }] : []),
      ]);
    } finally {
      // Scope changes and unmount already release these URLs and invalidate the batch.
      if (batches.current.delete(batch)) {
        setPending((tiles) => tiles.filter((tile) => tile.batch !== batch));
        for (const url of previews) URL.revokeObjectURL(url);
        setPreparing(batches.current.size > 0);
      }
    }
  };

  const removeAttachment = (index: number) => {
    const current = attachmentState.current;
    const next = current.attachments.filter((_, position) => position !== index);
    attachmentState.current = { ...current, attachments: next };
    current.onAttachmentsChange?.(next);
    setErrors([]);
  };

  return {
    preparing,
    pending,
    errors,
    addFiles,
    removeAttachment,
    clearErrors: () => setErrors([]),
    // Event handlers need the synchronous guard before React renders `preparing`.
    hasPending: () => batches.current.size > 0,
  };
}
