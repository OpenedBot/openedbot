/**
 * Thread lab prototype composer (dev only). The "Box" variant of
 * streaming-ui.pulseview.app/composers and a "Pill" that opens like the Grok
 * Bot prompt (`lib/dev/thread-lab-composer.ts`), on BoardUI tokens, with the
 * console's keyboard contract kept (`lib/composer-keyboard.ts`): desktop
 * Enter sends, finger Enter is a newline and Send fires on pointerdown, then
 * blurs.
 *
 * No `data-composer` on the field: the perf HUD observes that attribute, and
 * the lab can show two composers at once.
 */
import { ArrowUp, Mic, Plus, Square } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { cn, useCoarsePointer } from "@openedbot/browser-ui-kit";
import {
  composerFieldMaxHeight,
  keepSoftKeyboard,
  resizeComposerField,
  shouldSendComposerOnPointerDown,
  shouldSubmitComposerOnEnter,
} from "../../../lib/composer-keyboard";
import {
  nextPillExpanded,
  PILL_LEADING_PX,
  PILL_PAD_BOTTOM_PX,
  PILL_PAD_TOP_PX,
  PILL_ROW_INSET_PX,
  pillShellHeight,
} from "../../../lib/dev/thread-lab-composer";

/** Grok's 0.3 s geometry transition; `motion-reduce` drops it. */
const PILL_MOTION = "duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none";

export type LabComposerVariant = "box" | "pill";

export function LabComposer({
  variant,
  value,
  onChange,
  onSend,
  onStop,
  busy,
  model,
  placeholder = "Écrire un message",
}: {
  variant: LabComposerVariant;
  value: string;
  onChange: (next: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  model: string;
  placeholder?: string;
}) {
  const coarse = useCoarsePointer();
  const field = useRef<HTMLTextAreaElement>(null);
  const sentOnPointerDown = useRef(false);
  const empty = value.trim() === "";

  const [expanded, setExpanded] = useState(false);
  const [contentHeight, setContentHeight] = useState(0);
  const [trailingWidth, setTrailingWidth] = useState(36);
  const expandedRef = useRef(false);
  const trailing = useRef<HTMLDivElement>(null);

  /**
   * Grows the field, then (Pill) decides the layout from what was just
   * measured. Measured at the width the field has NOW: in the compact pill,
   * that is the width between `+` and the trailing controls.
   */
  const measure = useCallback(() => {
    const element = field.current;
    if (!element) return;
    const { height } = resizeComposerField(element, composerFieldMaxHeight());
    if (variant !== "pill") return;
    const next = nextPillExpanded(expandedRef.current, { value: element.value, scrollHeight: element.scrollHeight });
    expandedRef.current = next;
    setExpanded(next);
    setContentHeight(height);
  }, [variant]);

  useLayoutEffect(measure, [value, measure]);

  // The pad's padding animates when the pill opens, so the field widens over
  // 300 ms: re-measure on every width change. The hysteresis in
  // `nextPillExpanded` keeps a widening field from collapsing the pill.
  useEffect(() => {
    const element = field.current;
    if (!element || variant !== "pill") return;
    let width = element.offsetWidth;
    const observer = new ResizeObserver(() => {
      if (element.offsetWidth === width) return;
      width = element.offsetWidth;
      measure();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure, variant]);

  // The compact text stops before the trailing controls, whatever they hold.
  useEffect(() => {
    const element = trailing.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setTrailingWidth(element.offsetWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [variant]);

  const submit = () => {
    if (busy || empty) return;
    onSend();
    if (coarse) requestAnimationFrame(() => field.current?.blur());
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" && busy) {
      event.preventDefault();
      onStop();
      return;
    }
    if (shouldSubmitComposerOnEnter(event, coarse)) {
      event.preventDefault();
      submit();
    }
  };

  const onSendPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    keepSoftKeyboard(event);
    if (!shouldSendComposerOnPointerDown(coarse)) return;
    sentOnPointerDown.current = true;
    submit();
  };

  const onSendClick = () => {
    if (sentOnPointerDown.current) {
      sentOnPointerDown.current = false;
      return;
    }
    submit();
  };

  const textarea = (
    <textarea
      ref={field}
      rows={1}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      aria-label="Message"
      className={cn(
        "no-scrollbar w-full resize-none bg-transparent text-body-regular leading-6 text-text-primary caret-text-primary outline-none placeholder:text-text-tertiary",
        variant === "box" ? "min-h-10 px-2.5 pt-2 pb-1" : "block min-w-0 p-0",
      )}
    />
  );

  const send = busy ? (
    <button
      type="button"
      aria-label="Arrêter"
      onPointerDown={keepSoftKeyboard}
      onClick={onStop}
      className="grid size-9 shrink-0 place-items-center rounded-full bg-background-tertiary-default text-foreground-icon-primary transition-colors hover:bg-background-tertiary-hover"
    >
      <Square className="size-3.5 fill-current" aria-hidden />
    </button>
  ) : (
    <button
      type="button"
      aria-label="Envoyer"
      disabled={empty}
      onPointerDown={onSendPointerDown}
      onClick={onSendClick}
      className="grid size-9 shrink-0 place-items-center rounded-full bg-text-primary text-background-primary-default transition-[opacity,scale] active:scale-95 disabled:opacity-30"
    >
      <ArrowUp className="size-5" aria-hidden />
    </button>
  );

  const add = (
    <button
      type="button"
      aria-label="Ajouter (démo)"
      onPointerDown={keepSoftKeyboard}
      className="grid size-9 shrink-0 place-items-center rounded-full bg-composer-panel-add-background text-foreground-icon-primary transition-[background-color,scale] hover:bg-composer-panel-add-hover-background active:scale-[0.96]"
    >
      <Plus className="size-5" aria-hidden />
    </button>
  );

  const mic = (
    <button
      type="button"
      aria-label="Dicter (démo)"
      onPointerDown={keepSoftKeyboard}
      className="hidden size-9 shrink-0 place-items-center rounded-full text-foreground-icon-secondary transition-colors hover:bg-background-tertiary-default hover:text-foreground-icon-primary sm:grid"
    >
      <Mic className="size-[18px]" aria-hidden />
    </button>
  );

  const modelChip = (
    <span className="hidden h-8 items-center rounded-full px-2.5 text-body-2-medium text-text-secondary sm:inline-flex">
      {model}
    </span>
  );

  const hint = (
    <div className="flex h-[26px] items-center justify-between gap-3 px-2 text-body-2-medium text-text-tertiary">
      <span>{busy ? "Échap pour arrêter" : coarse ? "Entrée : nouvelle ligne" : "Entrée pour envoyer · Maj+Entrée : nouvelle ligne"}</span>
    </div>
  );

  if (variant === "pill") {
    const padStyle: CSSProperties = expanded
      ? { padding: `${PILL_PAD_TOP_PX}px 16px ${PILL_PAD_BOTTOM_PX}px 16px`, justifyContent: "flex-start" }
      : { padding: `0 ${PILL_ROW_INSET_PX * 2 + trailingWidth}px 0 ${PILL_LEADING_PX}px`, justifyContent: "center" };
    const rowStyle: CSSProperties = expanded
      ? { bottom: PILL_ROW_INSET_PX, height: 36 }
      : { bottom: 0, height: "100%" };
    return (
      <div className="flex w-full flex-col gap-1.5">
        <div
          data-busy={busy ? "" : undefined}
          data-expanded={expanded ? "" : undefined}
          onClick={(event) => {
            // A tap on `+` or Send must not raise the soft keyboard.
            if (event.target instanceof Element && event.target.closest("button")) return;
            field.current?.focus();
          }}
          style={{ height: pillShellHeight(expanded, contentHeight) }}
          className={cn(
            "relative cursor-text overflow-clip border border-border-button-default bg-background-primary-default shadow-xs transition-[height,border-radius,border-color,box-shadow] focus-within:border-border-button-hover focus-within:shadow-sm data-[busy]:border-border-button-hover",
            expanded ? "rounded-[22px]" : "rounded-[24px]",
            PILL_MOTION,
          )}
        >
          <div style={padStyle} className={cn("box-border flex h-full flex-col transition-[padding]", PILL_MOTION)}>
            {textarea}
          </div>
          {/* Over the pad, never in its flow: the row only changes place. */}
          <div
            style={{ ...rowStyle, insetInlineStart: PILL_ROW_INSET_PX, insetInlineEnd: PILL_ROW_INSET_PX }}
            className={cn("pointer-events-none absolute flex items-center justify-between transition-[bottom,height]", PILL_MOTION)}
          >
            <div className="pointer-events-auto flex items-center">{add}</div>
            <div ref={trailing} className="pointer-events-auto flex items-center gap-1">
              {modelChip}
              {mic}
              {send}
            </div>
          </div>
        </div>
        {hint}
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-1.5">
      <div
        data-busy={busy ? "" : undefined}
        onClick={(event) => {
          if (event.target === event.currentTarget) field.current?.focus();
        }}
        className={cn(
          "cursor-text border border-border-button-default bg-background-primary-default shadow-xs transition-[border-color,box-shadow] duration-200 focus-within:border-border-button-hover focus-within:shadow-sm data-[busy]:border-border-button-hover",
          "flex flex-col gap-1 rounded-[22px] p-2",
        )}
      >
        {textarea}
        <div className="flex items-center gap-1.5">
          {add}
          <div ref={trailing} className="ms-auto flex items-center gap-1">
            {modelChip}
            {mic}
            {send}
          </div>
        </div>
      </div>
      {hint}
    </div>
  );
}
