import {
  type DOMAttributes,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useThreadEditAvailability } from "../lib/thread/thread-edit-availability";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Ellipsis,
  Hash,
  Pencil,
  RefreshCw,
  Reply,
  Smile,
  Square,
  Volume2,
} from "lucide-react";
import { ContextMenu } from "radix-ui";
import {
  MESSAGE_REACTION_EMOJIS,
  replyQuoteText,
  type MessageReactionEmoji,
} from "@openedbot/conversation/domain/message-reply";
import type {
  MessageReactionDto,
  MessageReplyPreview,
} from "@openedbot/contracts-api";
import type { MessageVersionFamilyDto, MessageVersionLinkDto } from "@openedbot/contracts-api";
import { currentMessageVersionIndex } from "@openedbot/conversation/domain/message-version";
import {
  cn,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  useCoarsePointer,
} from "@openedbot/browser-ui-kit";
import { haptics } from "../lib/platform/haptics";
import { RiFileCopyLine, RiMoreFill } from "@remixicon/react";
import { BUI_MENU_ITEM, BUI_POPOVER, BuiContextMenu, BuiContextMenuContent, BuiContextMenuItem, BuiContextMenuTrigger } from "./boardui/menu";

export type MessageInteractionLabels = {
  reply: string;
  react: string;
  removeReaction: string;
  more: string;
  quoteFrom: (author: string) => string;
  operator: string;
  assistant: string;
  speak: string;
  stopSpeaking: string;
  speechFailed: string;
  copy: string;
  copied: string;
  copyFailed: string;
  /** Right click: the message's identifier, for support. */
  copyMessageId: string;
  edit: string;
  regenerate: string;
  previousVersion: string;
  nextVersion: string;
  versionCount: (current: number, total: number) => string;
};

type MessageSpeakerControl = {
  status: "idle" | "speaking" | "error";
  onToggle: () => void;
};

export type MessageSurface = "full" | "chrome" | "card";

export type MessageCardHover = {
  messageId?: string | null;
  labels: MessageInteractionLabels;
  onReply?: (messageId: string, quote?: string) => void;
  onReaction?: (messageId: string, emoji: MessageReactionEmoji, active: boolean) => void | Promise<void>;
  speakerFor?: (cardId: string, text: string) => MessageSpeakerControl | undefined;
  /** Text of the whole turn, when the bar closes a turn cut by tools. */
  copyText?: string | null;
  /** The turn's reactions: the state of the « utile » / « inutile » buttons. */
  reactions?: readonly MessageReactionDto[];
};

const ACTION =
  "flex size-[22px] items-center justify-center rounded-md bg-background-tertiary-default text-foreground-icon-tertiary outline-none transition-colors hover:text-foreground-icon-secondary focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:opacity-50 aria-pressed:text-foreground-icon-primary";

/**
 * The action row under an answer, the reference app's `IconBtn`: 32 px round buttons,
 * 16 px lucide icons at stroke 2, the secondary ink, the primary one and a
 * 6 % wash under the pointer (`--stream-*`, thread-theme.css).
 */
const BELOW_ACTION =
  "grid size-8 shrink-0 place-items-center rounded-full text-[var(--stream-fg2)] outline-none transition-colors hover:bg-[var(--stream-hover)] hover:text-[var(--stream-fg)] data-[state=open]:bg-[var(--stream-hover)] data-[state=open]:text-[var(--stream-fg)] focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:opacity-50 aria-pressed:text-[var(--stream-fg)] motion-reduce:transition-none";

/** The two ratings of the BoardUI template: useful, not useful. Exclusive. */
const HELPFUL: MessageReactionEmoji = "👍";
const UNHELPFUL: MessageReactionEmoji = "👎";

/** Duration of a long press: that of `Pressable` / the iOS context menu. */
const LONG_PRESS_MS = 450;
/** Past that, the finger scrolls the list: it is no longer a press. */
const LONG_PRESS_SLOP = 10;
/** Window during which the click synthesized by the finger lifting is ignored. */
const GHOST_CLICK_MS = 700;

/**
 * The long press that replaces hover on a touch screen.
 *
 * On a phone, the hover icon row was forced visible
 * permanently: three 28 px chips stuck to EVERY bubble, which stole
 * 5.5 rem of width from the text and misaligned the column. No native
 * messenger does that: a message's actions are obtained there by holding it
 * pressed, and arrive in a sheet anchored at the bottom.
 */
function useLongPress(onLongPress: () => void, enabled: boolean): Partial<DOMAttributes<HTMLElement>> {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  }, []);

  useEffect(() => clear, [clear]);

  if (!enabled) return {};

  return {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      // The mouse keeps hover; only the finger (or the stylus) triggers it.
      if (!event.isPrimary || event.pointerType === "mouse") return;
      origin.current = { x: event.clientX, y: event.clientY };
      timer.current = window.setTimeout(() => {
        timer.current = null;
        // The finger is still down: on lifting it, the engine synthesizes a
        // `click` at the same coordinates, which would land on the veil of the
        // sheet just mounted and close it at once. That
        // ghost click is swallowed: the same trap as iOS's « ghost click ».
        const swallow = (event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
        };
        document.addEventListener("click", swallow, true);
        window.setTimeout(() => document.removeEventListener("click", swallow, true), GHOST_CLICK_MS);
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const start = origin.current;
      if (!start) return;
      if (
        Math.abs(event.clientX - start.x) > LONG_PRESS_SLOP ||
        Math.abs(event.clientY - start.y) > LONG_PRESS_SLOP
      ) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    // Without that, WebKit opens ITS selection callout over the sheet.
    onContextMenu: (event) => event.preventDefault(),
  };
}

const PICKER_H = 40;
const PICKER_W = 232;
/** Composer + model label: the in-flow picker fell behind / below the fold. */
const COMPOSER_RESERVE = 96;

export function reactionPickerPosition(
  anchor: { top: number; bottom: number; left: number; right: number },
  viewport: { width: number; height: number },
  align: "start" | "end",
): { top: number; left: number; side: "top" | "bottom" } {
  const spaceBelow = viewport.height - anchor.bottom;
  const side: "top" | "bottom" = spaceBelow < PICKER_H + COMPOSER_RESERVE ? "top" : "bottom";
  const top = side === "top"
    ? Math.max(8, anchor.top - PICKER_H - 8)
    : anchor.bottom + 8;
  const left = align === "end"
    ? Math.max(8, anchor.right - PICKER_W)
    : Math.max(8, Math.min(anchor.left, viewport.width - PICKER_W - 8));
  return { top, left, side };
}

/**
 * The right click keeps the browser menu where it is useful: a text
 * selection (copy, search), a link, an image, a field. Stopped in capture,
 * the event does not reach the Radix trigger, which would otherwise cancel it.
 */
export function keepNativeContextMenu(event: ReactMouseEvent<HTMLElement>) {
  const target = event.target instanceof Element ? event.target : null;
  const selection = window.getSelection();
  const selected = Boolean(
    selection && !selection.isCollapsed && selection.toString().trim()
      && selection.anchorNode && event.currentTarget.contains(selection.anchorNode),
  );
  if (selected || target?.closest("a[href], img, video, audio, input, textarea, [contenteditable='true']")) {
    event.stopPropagation();
  }
}

export function MessageInteractionShell({
  children,
  context,
  messageId,
  replyTo,
  reactions = [],
  align,
  width = "fit",
  surface = "full",
  actions = "side",
  persistentActions = false,
  actionsReveal = false,
  labels,
  onReply,
  onReaction,
  speaker,
  copyText,
  versionFamily,
  onEdit,
  onRegenerate,
  onSelectVersion,
  footerStart,
}: {
  children: ReactNode;
  /** `below` bar: what precedes the actions on the same line (the author). */
  footerStart?: ReactNode;
  /** Visual context placed above the message, outside the zone that anchors
   * the hover actions. An answered question must not widen the bubble. */
  context?: ReactNode;
  messageId?: string | null;
  replyTo?: MessageReplyPreview | null;
  reactions?: readonly MessageReactionDto[];
  align: "start" | "end";
  /** `fill` for an article: no more 85% ceiling, the prose takes the column. */
  width?: "fit" | "fill";
  /**
   * `full`: bubble + hover + quote/reactions.
   * `chrome`: quote/reactions only (the cards carry the hover).
   * `card`: one card of the stack, hover only.
   */
  surface?: MessageSurface;
  /**
   * `side`: the hover row beside the bubble (messaging).
   * `below`: a bar under the reply, copy and read in the foreground:
   * the shape of AI Elements / prompt-kit for a long flat reply, where
   * a row stuck to the right edge of 72 ch would float in the void.
   * `menu`: nothing around the bubble, like the reference app's thread; the gestures
   * go through the right click (mouse) or the long press (touch).
   */
  actions?: "side" | "below" | "menu";
  /** `below` bar always visible (last reply), not only on hover. */
  persistentActions?: boolean;
  /** The row appears with a fade-up: the answer it belongs to has just finished. */
  actionsReveal?: boolean;
  labels: MessageInteractionLabels;
  onReply?: (messageId: string, quote?: string) => void;
  onReaction?: (messageId: string, emoji: MessageReactionEmoji, active: boolean) => void | Promise<void>;
  speaker?: MessageSpeakerControl;
  /** Exact public text rendered by the bubble; never raw persisted content. */
  copyText?: string | null;
  versionFamily?: MessageVersionFamilyDto | null;
  onEdit?: (messageId: string) => void;
  onRegenerate?: (messageId: string) => void;
  onSelectVersion?: (version: MessageVersionLinkDto) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pendingEmoji, setPendingEmoji] = useState<MessageReactionEmoji | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const pickerPanelRef = useRef<HTMLDivElement>(null);
  const canReply = Boolean(messageId && onReply);
  const canReact = Boolean(messageId && onReaction);
  const canCopy = Boolean(copyText?.trim());
  // Closed menus need no live subscription: only their edit controls depend
  // on this flag. Opening one reads the latest permission before rendering it.
  const editAllowed = useThreadEditAvailability((state) =>
    menuOpen || sheetOpen || contextOpen ? state.canEdit : true);
  const canEdit = Boolean(messageId && onEdit && editAllowed);
  const canRegenerate = Boolean(messageId && onRegenerate && editAllowed);
  const hasOverflow = canCopy || canEdit || canRegenerate || Boolean(speaker);
  const showHover = surface !== "chrome";
  const showChrome = surface !== "card";
  const interactive = showHover && (canReply || canReact || hasOverflow);
  // Touch: nothing beside the bubble, everything in the long-press sheet.
  const coarse = useCoarsePointer();
  const inlineActions = interactive && !coarse;
  const below = actions === "below" && inlineActions;
  const side = actions === "side" && inlineActions;
  const touchActions = interactive && coarse;
  // Touch PWA: the full AI reply (`surface="chrome"`) keeps two
  // actions visible under its content. Operator bubbles (`align="end"`)
  // and internal cards stay without a permanent bar.
  const touchAssistantActions = coarse && surface === "chrome" && align === "start" && canCopy;
  // Mouse: the right click on the bubble opens the same gestures, like the reference app (reactions first, then reply, copy…). Touch keeps the long press.
  const contextMenu = inlineActions && Boolean(messageId);
  const longPress = useLongPress(() => {
    haptics.light();
    setSheetOpen(true);
  }, touchActions);

  useEffect(() => {
    if (copyState !== "copied") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 1_200);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  useEffect(() => {
    if (!pickerOpen) return;
    const onDoc = (event: MouseEvent) => {
      const target = event.target as Node;
      if (pickerRef.current?.contains(target) || pickerPanelRef.current?.contains(target)) return;
      setPickerOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPickerOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen]);

  const copyValue = async (value: string | null | undefined) => {
    if (!value?.trim()) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };
  const copy = () => copyValue(copyText);

  const reacted = (emoji: MessageReactionEmoji) =>
    reactions.some((reaction) => reaction.emoji === emoji && reaction.reactedByMe);
  /** « utile » and « inutile » exclude each other: setting one removes the other. */
  const toggleVerdict = async (emoji: MessageReactionEmoji) => {
    if (!messageId || !onReaction || pendingEmoji) return;
    const other = emoji === HELPFUL ? UNHELPFUL : HELPFUL;
    const active = reacted(emoji);
    setPendingEmoji(emoji);
    try {
      if (!active && reacted(other)) await onReaction(messageId, other, true);
      await onReaction(messageId, emoji, active);
    } finally {
      setPendingEmoji(null);
    }
  };

  const toggle = async (emoji: MessageReactionEmoji, active: boolean) => {
    if (!messageId || !onReaction || pendingEmoji) return;
    setPendingEmoji(emoji);
    try {
      await onReaction(messageId, emoji, active);
      setPickerOpen(false);
    } finally {
      setPendingEmoji(null);
    }
  };

  return (
    <div
      className={cn(
        "flex w-full flex-col gap-1",
        width === "fill" || align === "start" ? "items-start" : "items-end",
      )}
      data-message-id={messageId ?? undefined}
      data-message-width={width}
      data-message-align={align}
    >
      {showChrome && replyTo ? <ReplyQuote reply={replyTo} labels={labels} /> : null}
      {context}
      {surface === "chrome" ? (
        <div className="w-full min-w-0">{children}</div>
      ) : (
      <div
        className={cn(
          "group/message flex",
          below ? "w-full flex-col items-start" : "items-end gap-1.5",
          !below && (width === "fill"
            ? "w-full"
            : side
              ? "max-w-[min(calc(85%+5.5rem),100%)]"
              : "max-w-[85%]"),
        )}
      >
        {contextMenu && messageId ? (
          <BuiContextMenu onOpenChange={setContextOpen}>
            <BuiContextMenuTrigger asChild onContextMenuCapture={keepNativeContextMenu}>
              {/* With no bar around it, the bubble carries the focus: the Menu key
                  (or Shift+F10) opens the same gestures there, as in the reference app. */}
              <div
                tabIndex={actions === "menu" ? 0 : undefined}
                className={cn(
                  "min-w-0",
                  (below || (actions === "menu" && width === "fill")) && "w-full",
                  actions === "menu" && "rounded-[18px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                {children}
              </div>
            </BuiContextMenuTrigger>
            <BuiContextMenuContent>
              {canReact ? (
                <div role="group" aria-label={labels.react} className="flex items-center gap-0.5 px-1 pb-1">
                  {MESSAGE_REACTION_EMOJIS.map((emoji) => {
                    const active = reacted(emoji);
                    return (
                      <ContextMenu.Item
                        key={emoji}
                        aria-label={active ? `${labels.removeReaction} ${emoji}` : `${labels.react} ${emoji}`}
                        disabled={pendingEmoji !== null}
                        onSelect={() => void (emoji === HELPFUL || emoji === UNHELPFUL ? toggleVerdict(emoji) : toggle(emoji, active))}
                        className={cn("flex size-8 cursor-pointer items-center justify-center rounded-2lg p-0 text-base outline-none data-[highlighted]:bg-dropdown-item-hover-background", active && "bg-background-tertiary-default")}
                      >
                        {emoji}
                      </ContextMenu.Item>
                    );
                  })}
                </div>
              ) : null}
              {canReply ? (
                <BuiContextMenuItem leading={<Reply className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />} onSelect={() => onReply?.(messageId, copyText ?? undefined)}>
                  {labels.reply}
                </BuiContextMenuItem>
              ) : null}
              {canCopy ? (
                <BuiContextMenuItem leading={<RiFileCopyLine className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />} onSelect={() => void copy()}>
                  {labels.copy}
                </BuiContextMenuItem>
              ) : null}
              {speaker ? (
                <BuiContextMenuItem
                  leading={speaker.status === "speaking"
                    ? <Square className="size-5 shrink-0 fill-current text-foreground-icon-secondary" aria-hidden />
                    : <Volume2 className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />}
                  onSelect={speaker.onToggle}
                >
                  {speaker.status === "speaking" ? labels.stopSpeaking : labels.speak}
                </BuiContextMenuItem>
              ) : null}
              {canEdit ? (
                <BuiContextMenuItem leading={<Pencil className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />} onSelect={() => onEdit?.(messageId)}>
                  {labels.edit}
                </BuiContextMenuItem>
              ) : null}
              {canRegenerate ? (
                <BuiContextMenuItem leading={<RefreshCw className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />} onSelect={() => onRegenerate?.(messageId)}>
                  {labels.regenerate}
                </BuiContextMenuItem>
              ) : null}
              <ContextMenu.Separator className="-mx-1.5 my-1 h-px bg-border-button-default" />
              <BuiContextMenuItem leading={<Hash className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />} onSelect={() => void copyValue(messageId)}>
                {labels.copyMessageId}
              </BuiContextMenuItem>
            </BuiContextMenuContent>
          </BuiContextMenu>
        ) : (
          <div className={cn("min-w-0", below && "w-full")} data-message-pressable={touchActions ? "" : undefined} {...longPress}>
            {children}
          </div>
        )}
        {inlineActions && below ? (
          <div data-message-actions-row="" className="flex w-full items-center justify-start gap-2">
            {footerStart ?? <span />}
            <div
              data-message-hover-actions=""
              data-message-actions-placement="below"
              aria-label={labels.more}
              className={cn(
                "mt-0.5 -ms-1.5 flex h-8 shrink-0 items-center transition-opacity duration-200",
                actionsReveal && "stream-enter",
                persistentActions ? "opacity-100" : "opacity-0 group-hover/reply:opacity-100 group-hover/message:opacity-100 group-focus-within/message:opacity-100",
                (pickerOpen || menuOpen) && "opacity-100",
              )}
            >
              {canReact && messageId ? (
                <div ref={pickerRef} className="relative">
                  <button
                    type="button"
                    aria-label={labels.react}
                    title={labels.react}
                    aria-expanded={pickerOpen}
                    aria-haspopup="true"
                    onClick={() => {
                      setMenuOpen(false);
                      setPickerOpen((open) => !open);
                    }}
                    className={BELOW_ACTION}
                  >
                    <Smile className="size-4" strokeWidth={2} aria-hidden />
                  </button>
                  {pickerOpen && onReaction ? (
                    <ReactionPicker
                      panelRef={pickerPanelRef}
                      anchorRef={pickerRef}
                      align={align}
                      labels={labels}
                      reactions={reactions}
                      pendingEmoji={pendingEmoji}
                      onToggle={toggle}
                    />
                  ) : null}
                </div>
              ) : null}
              {canReply && messageId ? (
                <button type="button" aria-label={labels.reply} title={labels.reply} onClick={() => onReply?.(messageId, copyText ?? undefined)} className={BELOW_ACTION}>
                  <Reply className="size-4" strokeWidth={2} aria-hidden />
                </button>
              ) : null}
              {hasOverflow ? (
                <DropdownMenu
                  open={menuOpen}
                  onOpenChange={(open) => {
                    if (open) setPickerOpen(false);
                    setMenuOpen(open);
                  }}
                >
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={copyState === "copied" ? labels.copied : labels.more}
                      title={copyState === "copied" ? labels.copied : labels.more}
                      className={BELOW_ACTION}
                    >
                      {copyState === "copied"
                        ? <Check className="size-4" strokeWidth={2} aria-hidden />
                        : <Ellipsis className="size-4" strokeWidth={2} aria-hidden />}
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className={cn(BUI_POPOVER, "min-w-[198px] gap-1")}>
                    {canCopy ? (
                      <DropdownMenuItem className={BUI_MENU_ITEM} onSelect={() => void copy()}>
                        <RiFileCopyLine className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
                        {copyState === "copied" ? labels.copied : labels.copy}
                      </DropdownMenuItem>
                    ) : null}
                    {canEdit && messageId ? (
                      <DropdownMenuItem className={BUI_MENU_ITEM} onSelect={() => onEdit?.(messageId)}>
                        <Pencil className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
                        {labels.edit}
                      </DropdownMenuItem>
                    ) : null}
                    {canRegenerate && messageId ? (
                      <DropdownMenuItem className={BUI_MENU_ITEM} onSelect={() => onRegenerate?.(messageId)}>
                        <RefreshCw className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
                        {labels.regenerate}
                      </DropdownMenuItem>
                    ) : null}
                    {speaker ? (
                      <DropdownMenuItem className={BUI_MENU_ITEM} onSelect={speaker.onToggle}>
                        {speaker.status === "speaking"
                          ? <Square className="size-5 shrink-0 fill-current text-foreground-icon-secondary" aria-hidden />
                          : <Volume2 className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />}
                        {speaker.status === "speaking" ? labels.stopSpeaking : labels.speak}
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          </div>
        ) : null}
        {side ? (
          <div
            data-message-hover-actions=""
            data-message-actions-placement="side"
            className={cn(
              "flex shrink-0 items-center gap-1 transition-opacity duration-150",
              align === "end" && "order-first",
              "opacity-0 group-hover/message:opacity-100 focus-within:opacity-100",
              (pickerOpen || menuOpen) && "opacity-100",
            )}
          >
            {canReact && messageId ? (
              <div ref={pickerRef} className="relative">
                <button
                  type="button"
                  aria-label={labels.react}
                  title={labels.react}
                  aria-expanded={pickerOpen}
                  aria-haspopup="true"
                  onClick={() => {
                    setMenuOpen(false);
                    setPickerOpen((open) => !open);
                  }}
                  className={ACTION}
                >
                  <Smile className="size-3" aria-hidden />
                </button>
                {pickerOpen && onReaction ? (
                  <ReactionPicker
                    panelRef={pickerPanelRef}
                    anchorRef={pickerRef}
                    align={align}
                    labels={labels}
                    reactions={reactions}
                    pendingEmoji={pendingEmoji}
                    onToggle={toggle}
                  />
                ) : null}
              </div>
            ) : null}
            {canReply && messageId ? (
              <button
                type="button"
                aria-label={labels.reply}
                title={labels.reply}
                onClick={() => onReply?.(messageId, copyText ?? undefined)}
                className={ACTION}
              >
                <Reply className="size-3" aria-hidden />
              </button>
            ) : null}
            {hasOverflow ? (
              <DropdownMenu
                open={menuOpen}
                onOpenChange={(open) => {
                  if (open) setPickerOpen(false);
                  setMenuOpen(open);
                }}
              >
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={copyState === "copied" ? labels.copied : labels.more}
                    title={copyState === "copied" ? labels.copied : labels.more}
                    className={ACTION}
                  >
                    {copyState === "copied"
                      ? <Check className="size-3" aria-hidden />
                      : <RiMoreFill className="size-3" aria-hidden />}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align={align === "end" ? "end" : "start"} className={cn(BUI_POPOVER, "min-w-[198px] gap-1")}>
                  {canCopy ? (
                    <DropdownMenuItem className={BUI_MENU_ITEM} onSelect={() => void copy()}>
                      <RiFileCopyLine className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
                      {copyState === "copied" ? labels.copied : labels.copy}
                    </DropdownMenuItem>
                  ) : null}
                  {canEdit && messageId ? (
                    <DropdownMenuItem className={BUI_MENU_ITEM} onSelect={() => onEdit?.(messageId)}>
                      <Pencil className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
                      {labels.edit}
                    </DropdownMenuItem>
                  ) : null}
                  {canRegenerate && messageId ? (
                    <DropdownMenuItem className={BUI_MENU_ITEM} onSelect={() => onRegenerate?.(messageId)}>
                      <RefreshCw className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
                      {labels.regenerate}
                    </DropdownMenuItem>
                  ) : null}
                  {speaker ? (
                    <DropdownMenuItem className={BUI_MENU_ITEM} onSelect={speaker.onToggle}>
                      {speaker.status === "speaking"
                        ? <Square className="size-5 shrink-0 fill-current text-foreground-icon-secondary" aria-hidden />
                        : <Volume2 className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />}
                      {speaker.status === "speaking" ? labels.stopSpeaking : labels.speak}
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        ) : null}
      </div>
      )}
      {touchAssistantActions ? (
        <div data-message-touch-actions="" className="flex min-h-11 items-center gap-0">
          <button
            type="button"
            aria-label={copyState === "copied" ? labels.copied : labels.copy}
            title={copyState === "copied" ? labels.copied : labels.copy}
            onClick={() => void copy()}
            className="openedbot-press flex h-11 w-8 items-center justify-center rounded-lg text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {copyState === "copied"
              ? <Check className="size-4" aria-hidden />
              : <Copy className="size-4" aria-hidden />}
          </button>
          <button
            type="button"
            aria-label={labels.more}
            title={labels.more}
            aria-expanded={sheetOpen}
            onClick={() => {
              haptics.light();
              setSheetOpen(true);
            }}
            className="openedbot-press flex h-11 w-8 items-center justify-center rounded-lg text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Ellipsis className="size-4" aria-hidden />
          </button>
        </div>
      ) : null}
      {showChrome && messageId && reactions.some((reaction) => align === "end" || (reaction.emoji !== HELPFUL && reaction.emoji !== UNHELPFUL)) ? (
        <div className={`flex flex-wrap items-center gap-1 ${align === "end" ? "justify-end" : "justify-start"}`}>
          {reactions.filter((reaction) => align === "end" || (reaction.emoji !== HELPFUL && reaction.emoji !== UNHELPFUL)).map((reaction) => (
            <button
              key={reaction.emoji}
              type="button"
              aria-pressed={reaction.reactedByMe}
              aria-label={reaction.reactedByMe ? labels.removeReaction : labels.react}
              disabled={!onReaction || pendingEmoji !== null}
              onClick={() => void toggle(reaction.emoji as MessageReactionEmoji, reaction.reactedByMe)}
              className={`rounded-full border px-2 py-0.5 text-xs tabular-nums transition-colors ${
                reaction.reactedByMe
                  ? "border-primary/40 bg-primary/10 text-foreground"
                  : "border-border/70 bg-background text-muted-foreground hover:bg-muted"
              }`}
            >
              <span aria-hidden>{reaction.emoji}</span> {reaction.count}
            </button>
          ))}
        </div>
      ) : null}
      {showChrome && versionFamily && versionFamily.versions.length > 1 && onSelectVersion ? (
        <MessageVersionNavigator family={versionFamily} labels={labels} onSelect={onSelectVersion} />
      ) : null}
      {touchActions || touchAssistantActions ? (
        <MessageActionSheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          labels={labels}
          reactions={canReact ? reactions : null}
          pendingEmoji={pendingEmoji}
          onToggleReaction={toggle}
          actions={[
            canReply && messageId
              ? { key: "reply", icon: <Reply className="size-5" aria-hidden />, label: labels.reply, run: () => onReply?.(messageId, copyText ?? undefined) }
              : null,
            canCopy
              ? { key: "copy", icon: <Copy className="size-5" aria-hidden />, label: labels.copy, run: () => void copy() }
              : null,
            speaker
              ? {
                  key: "speak",
                  icon: speaker.status === "speaking"
                    ? <Square className="size-5 fill-current" aria-hidden />
                    : <Volume2 className="size-5" aria-hidden />,
                  label: speaker.status === "speaking" ? labels.stopSpeaking : labels.speak,
                  run: speaker.onToggle,
                }
              : null,
            canEdit && messageId
              ? { key: "edit", icon: <Pencil className="size-5" aria-hidden />, label: labels.edit, run: () => onEdit?.(messageId) }
              : null,
            canRegenerate && messageId
              ? { key: "regenerate", icon: <RefreshCw className="size-5" aria-hidden />, label: labels.regenerate, run: () => onRegenerate?.(messageId) }
              : null,
          ]}
        />
      ) : null}
      {speaker?.status === "error" ? <span role="alert" className="sr-only">{labels.speechFailed}</span> : null}
      {copyState === "error" ? <span role="alert" className="sr-only">{labels.copyFailed}</span> : null}
    </div>
  );
}

type SheetAction = {
  key: string;
  icon: ReactNode;
  label: string;
  disabled?: boolean;
  run: () => void;
};

/**
 * A message's actions, in a sheet anchored at the bottom: a phone's native
 * modal presentation. `Dialog` already renders it that way under 640 px: handle,
 * rounded top corners, rising from the bottom, safe-area padding.
 *
 * Reactions at the top, in one 44 pt row; then the iOS grouped list:
 * 48 pt per row, icon on the left, a rule between the rows.
 */
function MessageActionSheet({
  open,
  onClose,
  labels,
  reactions,
  pendingEmoji,
  onToggleReaction,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  labels: MessageInteractionLabels;
  /** `null` when this message does not accept a reaction: no empty row. */
  reactions: readonly MessageReactionDto[] | null;
  pendingEmoji: MessageReactionEmoji | null;
  onToggleReaction: (emoji: MessageReactionEmoji, active: boolean) => void | Promise<void>;
  actions: readonly (SheetAction | null)[];
}) {
  const rows = actions.filter((action): action is SheetAction => action !== null);
  if (!rows.length && !reactions) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      ariaLabel={labels.more}
      showClose={false}
      autoFocus={false}
      className="max-sm:bg-background"
      bodyClassName="px-3 py-3"
    >
      {reactions ? (
        <div
          role="group"
          aria-label={labels.react}
          className="mb-3 flex items-center justify-between gap-1 rounded-2xl bg-muted/50 p-1"
        >
          {MESSAGE_REACTION_EMOJIS.map((emoji) => {
            const active = reactions.some((reaction) => reaction.emoji === emoji && reaction.reactedByMe);
            return (
              <button
                key={emoji}
                type="button"
                aria-label={`${labels.react} ${emoji}`}
                aria-pressed={active}
                disabled={pendingEmoji !== null}
                onClick={() => {
                  void onToggleReaction(emoji, active);
                  onClose();
                }}
                className={cn(
                  "openedbot-press flex size-11 flex-1 items-center justify-center rounded-xl text-2xl leading-none outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active && "bg-primary/15",
                )}
              >
                {emoji}
              </button>
            );
          })}
        </div>
      ) : null}
      {rows.length ? (
        <ul className="overflow-hidden rounded-2xl bg-muted/50">
          {rows.map((action) => (
            <li key={action.key} className="border-b border-border/50 last:border-b-0">
              <button
                type="button"
                disabled={action.disabled}
                onClick={() => {
                  action.run();
                  onClose();
                }}
                className="openedbot-press flex min-h-12 w-full items-center gap-3 px-4 text-left text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
              >
                <span className="text-muted-foreground">{action.icon}</span>
                {action.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </Dialog>
  );
}

function ReactionPicker({
  panelRef,
  anchorRef,
  align,
  labels,
  reactions,
  pendingEmoji,
  onToggle,
}: {
  panelRef: RefObject<HTMLDivElement | null>;
  anchorRef: RefObject<HTMLDivElement | null>;
  align: "start" | "end";
  labels: MessageInteractionLabels;
  reactions: readonly MessageReactionDto[];
  pendingEmoji: MessageReactionEmoji | null;
  onToggle: (emoji: MessageReactionEmoji, active: boolean) => void | Promise<void>;
}) {
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    const anchor = anchorRef.current?.querySelector("button") ?? anchorRef.current;
    if (!anchor) return;
    const place = () => {
      const next = reactionPickerPosition(
        anchor.getBoundingClientRect(),
        { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
        align,
      );
      setPos({ top: next.top, left: next.left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [align, anchorRef]);

  return createPortal(
    <div
      ref={panelRef}
      role="group"
      aria-label={labels.react}
      data-reaction-picker=""
      style={{ position: "fixed", top: pos.top, left: pos.left }}
      className="z-[120] flex items-center gap-0.5 rounded-full border bg-popover p-1 shadow-md"
    >
      {MESSAGE_REACTION_EMOJIS.map((emoji) => {
        const active = reactions.some((reaction) => reaction.emoji === emoji && reaction.reactedByMe);
        return (
          <button
            key={emoji}
            type="button"
            aria-label={`${labels.react} ${emoji}`}
            aria-pressed={active}
            disabled={pendingEmoji !== null}
            onClick={() => void onToggle(emoji, active)}
            className="rounded-full p-1 text-base leading-none outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          >
            {emoji}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

function MessageVersionNavigator({
  family,
  labels,
  onSelect,
}: {
  family: MessageVersionFamilyDto;
  labels: MessageInteractionLabels;
  onSelect: (version: MessageVersionLinkDto) => void;
}) {
  const index = currentMessageVersionIndex(family);
  if (index < 0) return null;
  const previous = family.versions[index - 1];
  const next = family.versions[index + 1];
  return (
    <div className="flex items-center gap-0.5 rounded-full border border-border/70 bg-background px-1 py-0.5 text-xs text-muted-foreground">
      <button
        type="button"
        aria-label={labels.previousVersion}
        title={labels.previousVersion}
        disabled={!previous}
        onClick={() => previous && onSelect(previous)}
        className="rounded-full p-0.5 outline-none hover:bg-muted disabled:opacity-30 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronLeft className="size-3.5" aria-hidden />
      </button>
      <span className="min-w-14 text-center tabular-nums">
        {labels.versionCount(index + 1, family.versions.length)}
      </span>
      <button
        type="button"
        aria-label={labels.nextVersion}
        title={labels.nextVersion}
        disabled={!next}
        onClick={() => next && onSelect(next)}
        className="rounded-full p-0.5 outline-none hover:bg-muted disabled:opacity-30 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

function ReplyQuote({ reply, labels }: { reply: MessageReplyPreview; labels: MessageInteractionLabels }) {
  const author = reply.authorBot?.name ?? reply.authorBot?.slug ??
    (reply.role === "assistant" ? labels.assistant : labels.operator);
  const excerpt = replyQuoteText(reply.content).slice(0, 180);
  const jumpToSource = () => {
    const target = document.querySelector<HTMLElement>(`[data-thread-find-target="message:${reply.id}"]`);
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
    target?.focus({ preventScroll: true });
  };
  return (
    <button
      type="button"
      onClick={jumpToSource}
      aria-label={labels.quoteFrom(author)}
      className="max-w-full rounded-lg border-l-2 border-primary/50 bg-muted/50 px-2.5 py-1.5 text-left text-xs text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="block font-medium text-foreground/80">{author}</span>
      <span className="block truncate">{excerpt || "…"}</span>
    </button>
  );
}
