import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Download, Loader2, X } from "lucide-react";
import { cn, useCoarsePointer, useIsMobile } from "@openedbot/browser-ui-kit";
import {
  attachmentBytes,
  type AttachmentContentPart,
  type MessageAttachmentInput,
} from "@openedbot/conversation/domain/attachments";
import { formatBytes } from "@openedbot/browser-i18n";
import type { MessageContent } from "@openedbot/contracts-api";
import { api } from "../lib/api";
import { releaseComposerKeyboard } from "../lib/composer/composer-keyboard";
import { useT } from "../lib/i18n";
import { documentMarkdownComponents } from "./thread-markdown";
import { CANVAS_MIN_WIDTH, useCanvasResize } from "./attachment-canvas-width";
export { CANVAS_MIN_WIDTH, CANVAS_THREAD_MIN_WIDTH, clampCanvasWidth, readCanvasWidth, writeCanvasWidth } from "./attachment-canvas-width";

/** The « pièce jointe » part of a message, as the cloud API persists it. */
export type MessageAttachmentChip = Extract<MessageContent[number], { type: "attachment" }>;

/** Shape shared by the thread's persisted file and the composer's still-local file.
 * The latter carries its content directly, the former only its id. */
export type AttachmentCanvasItem = {
  id?: string;
  name: string;
  contentType: string;
  kind: "image" | "document";
  bytes: number;
  content?: readonly AttachmentContentPart[];
};

export function draftAttachmentCanvasItem(attachment: MessageAttachmentInput): AttachmentCanvasItem {
  return { ...attachment, bytes: attachmentBytes(attachment) };
}

/**
 * The reading canvas for an attachment.
 *
 * By CONTEXT and not by props: the chip that opens it lives deep in
 * `ThreadTimeline`, under two `memo`s (`UserMessage`, `AttachmentTile`) whose
 * point is that the thread does not re-render on every stream delta.
 * Passing an `onOpen` down that far would hand a new function identity
 * on every render and break exactly what those `memo`s protect.
 *
 * One file open at a time: it is a reading panel, not a
 * tab manager.
 */
/**
 * A panel that is not a file (the context and quota detail):
 * the canvas lends it its shell (place in the row, card, animation) and a
 * DOM slot; its owner renders its content there through a portal. The
 * content thus stays with its owner, with its queries and its state, instead of being
 * frozen into a React node passed to the context.
 *
 * `id` names the instance that opened it: several triggers of the same
 * panel can be mounted together (header chip, line under the
 * composer), and only one must fill the slot.
 */
export type CanvasPanel = { id: string; label: string };

/** The open panel's slot, with the instance that must fill it. */
export type CanvasPanelSlot = { owner: string; element: HTMLElement };

const AttachmentCanvasContext = createContext<{
  open: (attachment: AttachmentCanvasItem) => void;
  opened: AttachmentCanvasItem | null;
  openPanel: (panel: CanvasPanel) => void;
  panel: CanvasPanel | null;
  panelSlot: CanvasPanelSlot | null;
  setPanelSlot: (slot: CanvasPanelSlot | null) => void;
  close: () => void;
} | null>(null);

export function AttachmentCanvasProvider({ children }: { children: ReactNode }) {
  const [opened, setOpened] = useState<AttachmentCanvasItem | null>(null);
  const [panel, setPanel] = useState<CanvasPanel | null>(null);
  const [panelSlot, setPanelSlot] = useState<CanvasPanelSlot | null>(null);
  const close = useCallback(() => {
    setOpened(null);
    setPanel(null);
  }, []);
  const open = useCallback((attachment: AttachmentCanvasItem) => {
    // On touch the panel takes the whole stage: opened with the keyboard up, it would
    // have shown in the band above it, and releasing afterwards
    // would have jumped the layout under the user's eyes.
    releaseComposerKeyboard();
    // One content at a time: the file replaces the panel.
    setPanel(null);
    setOpened(attachment);
  }, []);
  const openPanel = useCallback((next: CanvasPanel) => {
    releaseComposerKeyboard();
    setOpened(null);
    setPanel(next);
  }, []);
  const value = useMemo(
    () => ({ open, opened, openPanel, panel, panelSlot, setPanelSlot, close }),
    [open, opened, openPanel, panel, panelSlot, close],
  );
  return (
    <AttachmentCanvasContext.Provider value={value}>{children}</AttachmentCanvasContext.Provider>
  );
}

/**
 * Returns `null` outside a provider rather than throwing: the timeline is also
 * rendered by tests and screens that have no canvas, and a chip without a
 * panel must stay a chip, not a blank page.
 */
export function useAttachmentCanvas() {
  return useContext(AttachmentCanvasContext);
}

/**
 * The fold duration, in milliseconds.
 *
 * It is written TWICE: here and in the class's `duration-200`, because
 * Tailwind only reads literal classes. The comment is the link:
 * changing one without the other either unmounts the content too soon (one sees
 * the column empty) or holds it too long.
 */
const CLOSE_MS = 200;

/**
 * The canvas width on a desktop screen, declared ONCE: the
 * container animates it, the inside keeps it. Two values that diverged
 * would make the text dance during the transition.
 */
/**
 * The canvas card on desktop: the sidebar card's surface
 * (`BOARD_SIDEBAR_CARD`), same background and same edge. It sits on the thread's
 * background (`CANVAS_GUTTER`), as the sidebar sits on the page: transparent,
 * the gutter let `main`'s grey show under the card, as a rectangle.
 */
const CANVAS_CARD = "overflow-hidden rounded-3xl border border-border-button-white bg-background-secondary-default shadow-sm";
const CANVAS_GUTTER = "bg-background";
// The 20rem floor lives IN the width, never as `min-w-*`: set on the
// animated container, a `min-width` beats the starting width (0) and
// the transition jumped at once to 320 px, the thread shifted 160 px in one
// frame, before sliding the rest of the way.
const ATTACHMENT_CANVAS_WIDTH = "w-[max(20rem,min(42rem,38vw))]";

/**
 * The panel itself: beside the thread, never over it.
 *
 * A modal would hide the conversation, yet it is precisely while reading it
 * that one wants to consult the file it talks about. The panel therefore takes its
 * place in the row, and the thread tightens.
 */
export function AttachmentCanvas() {
  const { t, locale } = useT();
  const isMobile = useIsMobile();
  const coarse = useCoarsePointer();
  const canvas = useAttachmentCanvas();
  const opened = canvas?.opened ?? null;
  const panel = canvas?.panel ?? null;
  const close = canvas?.close;
  const setPanelSlot = canvas?.setPanelSlot;

  /**
   * The file still RENDERED once it is no longer open: for as long as the
   * panel takes to fold.
   *
   * Without it, closing would empty the content first and fold afterwards: one
   * would see a white column retract. `onTransitionEnd` unmounts it once
   * the space is given back, which also releases an image's object URL.
   */
  const [closing, setClosing] = useState<AttachmentCanvasItem | null>(null);
  const [closingPanel, setClosingPanel] = useState<CanvasPanel | null>(null);
  useEffect(() => {
    if (opened) {
      setClosing(opened);
      // A replaced panel must not come back during a later fold.
      setClosingPanel(null);
      return;
    }
    // The SAFETY NET under `onTransitionEnd` (set further down), not its replacement:
    // under `prefers-reduced-motion` the transition is disarmed and the event
    // NEVER fires: the content would stay mounted for good in a panel of
    // zero width, with its object URL and its buttons.
    const timer = setTimeout(() => setClosing(null), CLOSE_MS);
    return () => clearTimeout(timer);
  }, [opened]);
  // The same hold for a panel: its owner keeps its portal for as long as
  // the slot exists, so for as long as the card is folding.
  useEffect(() => {
    if (panel) {
      setClosingPanel(panel);
      setClosing(null);
      return;
    }
    const timer = setTimeout(() => setClosingPanel(null), CLOSE_MS);
    return () => clearTimeout(timer);
  }, [panel]);
  // The open content wins over the one folding: switching from a file to the
  // panel (or the reverse) shows the new one at once.
  const displayed = opened ?? (panel ? null : closing);
  const shownPanel = panel ?? (opened ? null : closingPanel);
  const shownPanelId = shownPanel?.id ?? null;
  const panelSlotRef = useCallback(
    (element: HTMLDivElement | null) => {
      setPanelSlot?.(element && shownPanelId ? { owner: shownPanelId, element } : null);
    },
    [setPanelSlot, shownPanelId],
  );

  const [text, setText] = useState<string | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // Escape closes, like every surface that closes in the application. Set
  // on the document: focus may still be in the composer.
  const active = Boolean(opened || panel);
  useEffect(() => {
    if (!active || !close) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, close]);

  // On the file's IDENTITY, not on the object: closing changes the
  // reference (`opened` → `closing`) without changing the file, and downloading again
  // while the panel folds would be work for no one.
  const shownId = displayed?.id ?? null;
  const shownKind = displayed?.kind ?? null;
  useEffect(() => {
    setText(null);
    setHtml(null);
    setImageUrl(null);
    setFailed(false);
    const directImage = displayed?.content?.find(
      (part): part is Extract<AttachmentContentPart, { type: "image" }> => part.type === "image",
    );
    if (shownKind === "image" && directImage) {
      setImageUrl(directImage.image);
      return;
    }
    const directText = displayed?.content
      ?.filter((part): part is Extract<AttachmentContentPart, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (shownKind === "document" && directText !== undefined) {
      if (displayed && isHtml(displayed)) setHtml(directText);
      else setText(directText);
      return;
    }
    if (!shownId) {
      setFailed(true);
      return;
    }
    let objectUrl: string | null = null;
    let cancelled = false;
    void api
      .attachment(shownId)
      .then(async (blob) => {
        if (cancelled) return;
        if (shownKind === "image") {
          objectUrl = URL.createObjectURL(blob);
          setImageUrl(objectUrl);
          return;
        }
        const body = await blob.text();
        if (displayed && isHtml(displayed)) setHtml(body);
        else setText(body);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      // Without revocation, opening ten attachments keeps ten files in memory
      // until the window closes.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [displayed, shownId, shownKind]);

  const mounted = Boolean(close);
  const { asideRef, resizing, shownWidth, maxWidth, resetWidth, startResize, moveResize, endResize, keyResize } = useCanvasResize(isMobile, mounted);

  // Outside a provider only. The panel stays MOUNTED even when empty: a
  // CSS transition only plays on an element that already existed on the previous
  // frame: mounting it at the moment of opening would make it appear
  // already unfolded, with no animation.
  if (!close) return null;

  const open = active;
  // The inside keeps the set width, even during the fold (see below).
  const innerWidth = shownWidth !== null ? { width: shownWidth } : undefined;
  return (
    <aside
      ref={asideRef}
      style={open && shownWidth !== null ? { width: shownWidth } : undefined}
      aria-label={shownPanel ? shownPanel.label : t("attachmentCanvas.label", { name: displayed?.name ?? "" })}
      aria-hidden={!open}
      // Once closed, the panel must not stay in the tab order for
      // the duration of its fold: `inert` takes its buttons off the keyboard at
      // once, without waiting for unmount.
      inert={!open}
      onTransitionEnd={(event) => {
        // The end of the fold, as soon as it arrives: the panel only transitions
        // its width and its opacity, which finish together: no need to
        // tell which. `target === currentTarget` ignores the
        // children's transitions (the buttons have their own).
        if (event.target === event.currentTarget && !open) {
          setClosing(null);
          setClosingPanel(null);
        }
      }}
      data-attachment-canvas=""
      className={cn(
        "flex shrink-0 flex-col overflow-hidden",
        // `duration-200` must stay in agreement with `CLOSE_MS`, on both sides.
        // `motion-reduce` disarms the motion, not the function.
        "duration-200 ease-out motion-reduce:transition-none",
        isMobile
          // Phone: a view PUSHED into the stage, not a layer laid
          // on the window. `position: fixed` locks to the layout
          // viewport, which neither the software keyboard nor Safari's URL bar
          // shrink: the panel then went under the keyboard and under
          // the home indicator. As `absolute`, it inherits the geometry
          // the shell takes from `visualViewport`, and the drawer carries it with
          // the stage instead of leaving it stuck to the screen.
          ? [
              // No `z-index`: the `absolute` already paints in front of the thread and the
              // composer, which stay static, and the frost then the veil of the
              // drawer, which come later in the stage, cover it
              // as they cover the rest when the panel opens.
              "absolute inset-0 bg-background transition-[transform,opacity]",
              open ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-4 opacity-0",
            ]
          // Desktop: a card (`CANVAS_CARD`) in an 8 px gutter at the
          // foot of the thread (`CANVAS_GUTTER`). The transition is on the width
          // of the CONTAINER; the inner card keeps its final size inside a
          // parent that clips, otherwise the text would reflow on every frame.
          // The margin is NOT on the container: an `m-2` would survive the
          // `w-0` and leave an empty band once the panel is closed.
          : [
              // While dragging, the width follows the pointer: no animation lagging behind.
              "relative",
              resizing ? "transition-none select-none" : "transition-[width,opacity]",
              CANVAS_GUTTER,
              open ? cn(ATTACHMENT_CANVAS_WIDTH, "opacity-100") : "pointer-events-none w-0 opacity-0",
            ],
      )}
    >
      {/* The handle occupies the gutter on the thread side (8 px): one finds it at the
          edge of the card without it eating the content. No stroke is drawn:
          only the resize cursor signals it. Desktop only:
          on a phone the panel takes the whole screen. */}
      {!isMobile && open ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("attachmentCanvas.resize")}
          title={t("attachmentCanvas.resize")}
          aria-valuemin={CANVAS_MIN_WIDTH}
          aria-valuemax={maxWidth}
          aria-valuenow={shownWidth ?? undefined}
          tabIndex={0}
          data-canvas-resize=""
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onLostPointerCapture={endResize}
          onDoubleClick={resetWidth}
          onKeyDown={keyResize}
          className="absolute inset-y-0 start-0 z-10 w-2 cursor-col-resize touch-none outline-none"
        />
      ) : null}
      {shownPanel ? (
        <div className={cn("flex min-h-0 flex-1 flex-col", isMobile ? "w-full" : cn(ATTACHMENT_CANVAS_WIDTH, "p-2"))} style={innerWidth}>
          <div
            ref={panelSlotRef}
            data-canvas-panel=""
            className={cn(
              "flex min-h-0 flex-1 flex-col",
              !isMobile && CANVAS_CARD,
            )}
          />
        </div>
      ) : displayed ? (
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col",
            // The desktop container shrinks down to 0: the inside keeps its
            // final width so its text does not reflow on every frame.
            // `p-2` is the card's gutter, clipped with the panel.
            isMobile ? "w-full" : cn(ATTACHMENT_CANVAS_WIDTH, "p-2"),
          )}
          style={innerWidth}
        >
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col",
              !isMobile && CANVAS_CARD,
            )}
          >
            <header
              className={cn(
                "flex shrink-0 items-center gap-2 border-b px-4",
                // 44 pt on touch (HIG / WCAG 2.5.8): the panel bar is
                // handled like a navigation bar, not like desktop
                // chrome.
                coarse ? "border-border/60 py-1.5" : "border-border py-3",
              )}
            >
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium" title={displayed.name}>
                {displayed.name}
              </span>
              <span className="text-xs text-muted-foreground">{formatBytes(locale, displayed.bytes)}</span>
            </div>
            <button
              type="button"
              onClick={() => void downloadCanvasAttachment(displayed)}
              aria-label={t("attachmentCanvas.download")}
              title={t("attachmentCanvas.download")}
              className={canvasChromeButton(coarse)}
            >
              <Download className="size-4" />
            </button>
            <button
              type="button"
              onClick={close}
              aria-label={t("attachmentCanvas.close")}
              title={t("attachmentCanvas.close")}
              className={canvasChromeButton(coarse)}
            >
              <X className="size-4" />
            </button>
          </header>

          <div
            className={cn(
              "min-h-0 flex-1",
              html !== null
                // The HTML runs in its frame: that is what scrolls, not the
                // panel, otherwise one page would have two scrollbars.
                ? "flex flex-col overflow-hidden"
                : [
                    // `overscroll-contain`: at the end of the scroll, the gesture
                    // does not continue into the thread left behind.
                    "scrollbar-subtle overflow-y-auto overscroll-contain px-4 py-3",
                    // The panel goes down to the edge of the stage, where the
                    // home indicator sits: it is the CONTENT that keeps its
                    // clearance, not the background.
                    isMobile && "pb-[max(0.75rem,var(--openedbot-safe-bottom))]",
                    // An image is read whole, centred, without scrolling.
                    imageUrl ? "flex items-center justify-center bg-muted/30" : undefined,
                  ],
            )}
          >
            {failed ? (
              <p className="text-sm text-destructive-text">{t("attachmentCanvas.unreadable")}</p>
            ) : imageUrl ? (
              <img
                src={imageUrl}
                alt={displayed.name}
                className="h-full w-full object-contain"
              />
            ) : html !== null ? (
              // A srcdoc inherits the console's CSP (`vite-csp.ts`): the
              // document's scripts do not run there, and that is intended. A
              // data: or blob: URL inherits the same in Chromium (checked on
              // 2026-10-17); only 'unsafe-inline' would reopen them, at the cost of
              // the whole console's protection. The sandbox stays.
              <iframe
                title={displayed.name}
                srcDoc={html}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                className="h-full min-h-[24rem] w-full flex-1 border-0 bg-white"
              />
            ) : text !== null ? (
              isMarkdown(displayed) ? (
                <div className="prose prose-sm max-w-none dark:prose-invert prose-headings:mt-4 prose-headings:mb-2 prose-p:my-2">
                  <Markdown remarkPlugins={[remarkGfm]} components={documentMarkdownComponents}>
                    {text}
                  </Markdown>
                </div>
              ) : (
                // Anything that is not markdown is read as it is written:
                // passing a `.ts` or a `.csv` to the parser would turn it into bold and
                // italic at the first `*`.
                <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                  {text}
                </pre>
              )
            ) : (
              <div className="flex items-center justify-center py-8">
                <Loader2
                  className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
                  aria-hidden
                />
              </div>
            )}
          </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}

/** The canvas chrome buttons: compact on desktop, 44 pt on touch. */
export function canvasChromeButton(coarse: boolean): string {
  return coarse
    ? "openedbot-press flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    : "openedbot-settings-action mt-0.5 inline-flex shrink-0 items-center justify-center rounded-md p-1 text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";
}

/** The MIME type first, the extension second: a `.md` sometimes arrives bare. */
function isMarkdown(attachment: Pick<AttachmentCanvasItem, "contentType" | "name">): boolean {
  return (
    attachment.contentType === "text/markdown" || /\.(md|markdown)$/i.test(attachment.name)
  );
}

/** Same rule as the GET: the MIME first, the extension second. */
function isHtml(attachment: Pick<AttachmentCanvasItem, "contentType" | "name">): boolean {
  const mime = attachment.contentType.toLowerCase().split(";")[0]?.trim();
  return mime === "text/html" || /\.(html|htm)$/i.test(attachment.name);
}

/**
 * Hand the file back to its owner: an `<a download>` on an object URL,
 * revoked just after. Created on click and not on render: keeping a live URL
 * for a click that may never come would hold the file in
 * memory for nothing.
 */
export async function downloadAttachment(attachment: MessageAttachmentChip): Promise<void> {
  // Without an `id`, nothing was stored (message from before `0020`): one does not
  // download a file that no longer exists.
  if (!attachment.id) return;
  await downloadCanvasAttachment(attachment);
}

async function downloadCanvasAttachment(attachment: AttachmentCanvasItem): Promise<void> {
  let blob: Blob;
  if (attachment.id) {
    blob = await api.attachment(attachment.id);
  } else {
    const image = attachment.content?.find(
      (part): part is Extract<AttachmentContentPart, { type: "image" }> => part.type === "image",
    );
    if (image) blob = await (await fetch(image.image)).blob();
    else {
      const text = attachment.content
        ?.filter((part): part is Extract<AttachmentContentPart, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      if (text === undefined) return;
      blob = new Blob([text], { type: attachment.contentType || "text/plain" });
    }
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = attachment.name;
  anchor.click();
  URL.revokeObjectURL(url);
}
