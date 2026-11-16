import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { MESSAGE_REACTION_EMOJIS, type MessageReactionEmoji } from "@openedbot/conversation/domain/message-reply";
import type { MessageReactionDto } from "@openedbot/contracts-api";
import { cn } from "@openedbot/browser-ui-kit";
import { reactedByMe } from "../lib/thread/message-reactions";
import type { MessageInteractionLabels } from "./message-interactions";

const PICKER_H = 40;
const PICKER_W = 232;
/** Between the trigger and the picker. */
const PICKER_GAP = 6;
/** Kept free along the edges of the visible thread. */
const PICKER_MARGIN = 8;

type PickerRect = { top: number; bottom: number; left: number; right: number };
export type ReactionPickerPlacement = { top: number; left: number; side: "bottom" | "inline" | "top" };

/**
 * Where the emoji row opens, against its trigger in the action bar.
 *
 * The bar sits right under the reply, so opening above it covers the reply's
 * last lines (« Quel test veux-tu effectuer ? » under the pill). Hence:
 * 1. below the bar when the visible thread (`bounds`, the scroller clipped
 *    to the viewport, above the composer) has room;
 * 2. else on the bar's own line, beside the trigger (over the next actions,
 *    never over text);
 * 3. above only when neither fits, a narrow window at the very bottom.
 */
export function reactionPickerPosition(
  anchor: PickerRect,
  bounds: PickerRect,
  align: "start" | "end",
  size: { width: number; height: number } = { width: PICKER_W, height: PICKER_H },
): ReactionPickerPlacement {
  const minTop = bounds.top + PICKER_MARGIN;
  const maxTop = bounds.bottom - PICKER_MARGIN - size.height;
  const minLeft = bounds.left + PICKER_MARGIN;
  const maxLeft = bounds.right - PICKER_MARGIN - size.width;
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));
  const alignedLeft = clamp(align === "end" ? anchor.right - size.width : anchor.left, minLeft, maxLeft);

  const below = anchor.bottom + PICKER_GAP;
  if (below <= maxTop) return { top: below, left: alignedLeft, side: "bottom" };

  const besideLeft = align === "end" ? anchor.left - PICKER_GAP - size.width : anchor.right + PICKER_GAP;
  if (besideLeft >= minLeft && besideLeft <= maxLeft) {
    const centred = anchor.top + (anchor.bottom - anchor.top - size.height) / 2;
    return { top: clamp(centred, minTop, maxTop), left: besideLeft, side: "inline" };
  }

  return { top: Math.max(minTop, anchor.top - PICKER_GAP - size.height), left: alignedLeft, side: "top" };
}

/** The visible part of the trigger's scroller: the composer sits outside it. */
function reactionPickerBounds(anchor: Element): PickerRect {
  const viewport = { top: 0, left: 0, bottom: document.documentElement.clientHeight, right: document.documentElement.clientWidth };
  for (let node = anchor.parentElement; node && node !== document.body; node = node.parentElement) {
    if (!/(auto|scroll)/.test(getComputedStyle(node).overflowY)) continue;
    const rect = node.getBoundingClientRect();
    return {
      top: Math.max(viewport.top, rect.top),
      bottom: Math.min(viewport.bottom, rect.bottom),
      left: Math.max(viewport.left, rect.left),
      right: Math.min(viewport.right, rect.right),
    };
  }
  return viewport;
}

/**
 * The emoji row of the action bar. Positioned against the trigger, never
 * over the reply it reacts to (see `reactionPickerPosition`). A toolbar:
 * arrows, Home and End move between emojis, Escape closes and gives focus
 * back to the trigger.
 */
export function ReactionPicker({
  panelRef,
  anchorRef,
  align,
  labels,
  reactions,
  onToggle,
  onClose,
}: {
  panelRef: RefObject<HTMLDivElement | null>;
  anchorRef: RefObject<HTMLDivElement | null>;
  align: "start" | "end";
  labels: MessageInteractionLabels;
  reactions: readonly MessageReactionDto[];
  onToggle: (emoji: MessageReactionEmoji, active: boolean) => void | Promise<void>;
  onClose: () => void;
}) {
  const [pos, setPos] = useState<ReactionPickerPlacement | null>(null);
  const trigger = () => anchorRef.current?.querySelector("button") ?? null;

  useLayoutEffect(() => {
    const anchor = trigger();
    if (!anchor) return;
    const place = () => {
      const panel = panelRef.current?.getBoundingClientRect();
      setPos(reactionPickerPosition(
        anchor.getBoundingClientRect(),
        reactionPickerBounds(anchor),
        align,
        panel && panel.width > 0 ? { width: panel.width, height: panel.height } : undefined,
      ));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [align, anchorRef, panelRef]);

  // Focus enters the row once it is placed (a hidden element takes no focus),
  // on the first emoji already chosen if any.
  const placed = pos !== null;
  useEffect(() => {
    if (!placed) return;
    const buttons = [...(panelRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const pressed = buttons.find((button) => button.getAttribute("aria-pressed") === "true");
    (pressed ?? buttons[0])?.focus({ preventScroll: true });
  }, [placed, panelRef]);

  // Focus goes back to the trigger when the row closes with focus inside it.
  useEffect(() => {
    const panel = panelRef.current;
    const opener = anchorRef.current?.querySelector("button") ?? null;
    return () => {
      const active = document.activeElement;
      if (opener?.isConnected && (!active || active === document.body || panel?.contains(active))) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [anchorRef, panelRef]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      trigger()?.focus({ preventScroll: true });
      return;
    }
    const buttons = [...(panelRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const last = buttons.length - 1;
    const next = event.key === "ArrowRight" || event.key === "ArrowDown" ? (index < 0 || index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index <= 0 ? last : index - 1)
        : event.key === "Home" ? 0
          : event.key === "End" ? last
            : null;
    if (next === null) return;
    event.preventDefault();
    buttons[next]?.focus({ preventScroll: true });
  };

  return createPortal(
    <div
      ref={panelRef}
      role="toolbar"
      aria-label={labels.react}
      aria-orientation="horizontal"
      data-reaction-picker=""
      data-side={pos?.side}
      onKeyDown={onKeyDown}
      // Hidden until measured: the first frame would otherwise sit at 0,0.
      style={{ position: "fixed", top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? undefined : "hidden" }}
      className="z-[120] flex items-center gap-0.5 rounded-full border bg-popover p-1 shadow-md"
    >
      {MESSAGE_REACTION_EMOJIS.map((emoji) => {
        const active = reactedByMe(reactions, emoji);
        return (
          <button
            key={emoji}
            type="button"
            aria-label={`${active ? labels.removeReaction : labels.react} ${emoji}`}
            aria-pressed={active}
            onClick={() => void onToggle(emoji, active)}
            className={cn(
              "rounded-full p-1 text-base leading-none outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
              active && "bg-primary/15",
            )}
          >
            {emoji}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
