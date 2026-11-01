import type { ComponentType } from "react";
import { File as FileGeneric, FileCode, FileJson, FileSpreadsheet, FileText } from "lucide-react";
import { cn } from "@openedbot/browser-ui-kit";
import { keepSoftKeyboard } from "../lib/composer-keyboard";

/**
 * The 56 px attachment tile of the composer, cloned from the reference's
 * "Composer Attachments" (streaming-ui.pulseview.app): rounded-xl, 1 px edge,
 * a clockwise accent ring with a 9 px percentage while the file is being
 * read, then the percentage blurs out and the dismiss button blurs in on the
 * same spot. Images fill the tile and get a frosted dismiss; documents carry a
 * file-type icon over a 9 px name.
 *
 * `progress` is the REAL read progress (FileReader, see `prepareAttachments`),
 * 0..100 while the file is being prepared, `undefined` once it has landed.
 */

/** The rounded-rect outline the ring traces, starting top-centre (pathLength 100). */
const RING =
  "M 28 1 H 44 A 11 11 0 0 1 55 12 V 44 A 11 11 0 0 1 44 55 H 12 A 11 11 0 0 1 1 44 V 12 A 11 11 0 0 1 12 1 Z";

type Icon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

const SPREADSHEET = new Set(["csv", "tsv"]);
const JSON_LIKE = new Set(["json", "jsonl"]);
const PROSE = new Set(["md", "markdown", "txt", "text", "log"]);

/** A file-type icon from the extension; code is the default for the text types we accept. */
export function attachmentFileIcon(name: string): Icon {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (SPREADSHEET.has(extension)) return FileSpreadsheet;
  if (JSON_LIKE.has(extension)) return FileJson;
  if (PROSE.has(extension)) return FileText;
  if (!extension) return FileGeneric;
  return FileCode;
}

export function ComposerAttachmentTile({
  name,
  image,
  progress,
  title,
  landed = false,
  onRemove,
  removeLabel,
  open,
}: {
  name: string;
  /** An image source (data URI or object URL); documents leave it out. */
  image?: string;
  progress?: number;
  title?: string;
  /** Already in the draft: it mounts without the entrance its pending tile played. */
  landed?: boolean;
  onRemove?: () => void;
  removeLabel: string;
  /** Opens the image in the attachment canvas; absent where there is none. */
  open?: { onOpen: () => void; label: string };
}) {
  const uploading = progress !== undefined;
  const percent = Math.round(Math.max(0, Math.min(100, progress ?? 100)));
  const FileIcon = attachmentFileIcon(name);
  const frame = (
    <>
      {image ? (
        <img
          src={image}
          alt={open ? "" : name}
          className={cn(
            "absolute inset-0 size-full rounded-[11px] object-cover transition-opacity duration-300 ease-out",
            uploading && "opacity-60",
          )}
        />
      ) : (
        <span className={cn("transition-opacity duration-300 ease-out", uploading && "opacity-60")}>
          <FileIcon className="absolute start-[3px] top-1 size-6 text-text-secondary" aria-hidden />
          <span className="absolute start-1.5 top-9 max-w-[44px] truncate text-[9px] leading-[15px] font-medium tracking-[0.2px] text-text-secondary">
            {name}
          </span>
        </span>
      )}
    </>
  );
  return (
    <li
      data-composer-attachment-tile=""
      data-composer-image-attachment={image ? "" : undefined}
      data-composer-file-attachment={image ? undefined : ""}
      data-uploading={uploading ? "" : undefined}
      data-landed={landed ? "" : undefined}
      className="ohb-tile-in"
    >
      <div
        title={title ?? name}
        className="relative size-14 shrink-0 rounded-xl border border-composer-tile-border"
      >
        {open ? (
          <button
            type="button"
            onClick={open.onOpen}
            aria-label={open.label}
            className="absolute inset-0 cursor-pointer rounded-[11px] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring"
          >
            {frame}
          </button>
        ) : (
          frame
        )}
        <svg
          aria-hidden="true"
          viewBox="0 0 56 56"
          className={cn(
            "pointer-events-none absolute -inset-px size-14 transition-opacity duration-300 ease-out",
            uploading ? "opacity-100" : "opacity-0",
          )}
        >
          <path
            d={RING}
            fill="none"
            stroke="var(--color-accent-500)"
            strokeWidth="2"
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={`${uploading ? percent : 102} 200`}
            className="transition-[stroke-dasharray] duration-200 ease-linear"
          />
        </svg>
        <span
          data-composer-tile-percent=""
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute end-[3px] top-[3px] text-[9px] leading-4 font-medium tabular-nums transition-[opacity,filter] duration-300 ease-out",
            image ? "text-white" : "text-accent-500",
            uploading ? "opacity-100 blur-[0px]" : "opacity-0 blur-[3px]",
          )}
        >
          {percent}%
        </span>
        <button
          type="button"
          onPointerDown={keepSoftKeyboard}
          onClick={onRemove}
          disabled={uploading}
          aria-label={removeLabel}
          className={cn(
            // 16 px to the eye, 40 px to a finger (hit slop), as the other composer buttons.
            "absolute start-[35px] top-[3px] inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full outline-none select-none transition-[opacity,filter,color] duration-300 ease-out before:absolute before:-inset-3 before:content-[''] focus-visible:ring-2 focus-visible:ring-border-focus-ring",
            image
              ? "bg-white/50 text-white backdrop-blur-[2px] hover:text-white"
              : "bg-background-tertiary-default/50 text-foreground-icon-secondary hover:text-text-primary",
            uploading ? "pointer-events-none opacity-0 blur-[3px]" : "opacity-100 blur-[0px]",
          )}
        >
          <svg width="6.8" height="6.8" viewBox="0 0 6.8 6.8" fill="none" aria-hidden="true">
            <path d="M0.57 0.57L6.23 6.23" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <path d="M6.23 0.57L0.57 6.23" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </li>
  );
}
