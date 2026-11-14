import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type ComponentType,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { Square } from "lucide-react";
import { RiAddFill, RiApps2AddLine, RiAttachment2, RiCheckLine, RiFocus3Line, RiListCheck3 } from "@remixicon/react";
import { BUI_PANEL_ITEM, BuiPopover, BuiPopoverContent, BuiPopoverTrigger, BuiSectionLabel } from "./boardui/menu";
import { StreamIcon } from "./stream/stream-icons";
import { useMobileDrawer } from "./mobile/mobile-drawer-shell";
import {
  cn,
  Dialog,
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  useCoarsePointer,
} from "@openedbot/browser-ui-kit";
import {
  composerFieldCeiling,
  keepSoftKeyboard,
  releaseComposerKeyboard,
  resizeComposerField,
  shouldSendComposerOnPointerDown,
  shouldSubmitComposerOnEnter,
} from "../lib/composer/composer-keyboard";
import { ComposerReplyTab } from "./composer-reply-tab";
import { nextComposerExpanded } from "../lib/composer/composer-pill";
import { animateComposerExpand } from "../lib/thread/thread-motion";
import { focusComposerField } from "../lib/composer/composer-desktop-focus";
import { isNativeShell } from "../lib/platform";
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_LIMITS,
  attachmentBytes,
  type MessageAttachmentInput,
} from "@openedbot/conversation/domain/attachments";
import { formatBytes } from "@openedbot/browser-i18n";
import { type AttachmentError } from "../lib/composer/attachments";
import { useComposerAttachments } from "../lib/composer/use-composer-attachments";
import {
  bestPlainMatch,
  findMentionTrigger,
  findWordAtCaret,
  type MentionableBot,
  type TextRange,
} from "@openedbot/roster/domain/mentions";
import { segmentMcpPlugins } from "@/lib/runtime/mcp-plugins";
import {
  caretOffsetLeft,
  markMentions,
  mentionEndingAt,
  mentionRanges,
  removeRange,
} from "../lib/composer/composer-mentions";
import { ComposerAttachmentTile } from "./composer-attachment-tile";
import { MentionSuggestions, mentionOptionId } from "./mention-suggestions";
import { PluginBadge } from "./plugin-badge";
import {
  applyMentionPick,
  buildMentionOptions,
  type MentionOption,
} from "../lib/composer/mention-options";
import { draftAttachmentCanvasItem, useAttachmentCanvas } from "./attachment-canvas";
import { haptics } from "../lib/platform/haptics";
import { useT } from "../lib/i18n";
import { BUTTON } from "./settings/primitives";

/**
 * The composer as a pill.
 *
 * The textarea grows with the content up to a ceiling, then scrolls: a
 * fixed height would cut a multi-line message one is in the middle of writing,
 * and growth with no ceiling would eat the thread. Measurement goes through
 * `resizeComposerField`: `height: auto` alone is a no-op on WebKit.
 */

/**
 * A word, letter by letter, on the rainbow.
 *
 * The hue runs over 300°, from red to magenta, rather than over the full
 * turn: looping would bring the last letter back to the first letter's colour,
 * and a three-letter word would have almost no spread. The graduation is
 * done on `length - 1` so the last letter really reaches the end
 * of the spectrum; a one-letter word starts in the middle.
 *
 * The split goes through `Array.from`: `split("")` would cut an emoji or a
 * character outside the BMP into two invalid halves, and the mirror would no longer show
 * the same text as the field.
 */
const RAINBOW_ARC_DEGREES = 300;

function rainbowLetters(word: string): ReactNode[] {
  const letters = Array.from(word);
  return letters.map((letter, index) => (
    <span
      key={index}
      className="openedbot-mcp-letter"
      style={{
        "--openedbot-mcp-hue": `${
          letters.length === 1
            ? RAINBOW_ARC_DEGREES / 2
            : (index / (letters.length - 1)) * RAINBOW_ARC_DEGREES
        }deg`,
      } as CSSProperties}
    >
      {letter}
    </span>
  ));
}

/** Stable reference: a `[]` literal as a prop default would re-render on every keystroke. */
const EMPTY_ATTACHMENTS: readonly MessageAttachmentInput[] = [];
const EMPTY_MCP_PLUGINS: readonly string[] = [];

function ComposerDisabledSurface({
  disabled,
  reason,
  coarse,
  children,
}: {
  disabled: boolean;
  reason?: string;
  coarse: boolean;
  children: ReactNode;
}) {
  const { t } = useT();
  const [dialogOpen, setDialogOpen] = useState(false);
  if (!disabled || !reason) return children;

  const trigger = coarse ? (
    <div className="relative w-full" data-composer-disabled-surface="">
      {children}
      <button
        type="button"
        aria-label={reason}
        className="absolute inset-0 z-10 cursor-not-allowed rounded-[22px] bg-transparent"
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => setDialogOpen(true)}
      />
    </div>
  ) : (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div data-composer-disabled-surface="">{children}</div>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8}>{reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );

  return (
    <>
      {trigger}
      {coarse ? (
        <Dialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          role="alertdialog"
          title={t("conversation.unavailable")}
          description={reason}
          showClose={false}
          swipeToDismiss={false}
          closeLabel={t("common.close")}
          footer={(
            <button type="button" className={BUTTON.primary} onClick={() => setDialogOpen(false)}>
              {t("common.close")}
            </button>
          )}
        />
      ) : null}
    </>
  );
}

export function Composer({
  value,
  onChange,
  onSubmit,
  onCancel,
  botName,
  disabled,
  disabledReason,
  running,
  sending = false,
  mentionables = [],
  mcpPlugins = EMPTY_MCP_PLUGINS,
  attachments = EMPTY_ATTACHMENTS,
  onAttachmentsChange,
  attachmentScope,
  draftUnpersisted = false,
  modelControl,
  statusTab,
  statusLeft,
  contextMeter,
  notice,
  replyPreview,
  onCancelReply,
  goal,
  onSetGoal,
  onClearGoal,
  planFirst = false,
  onPlanFirstChange,
  onManagePlugins,
  showPlugins = true,
  planPending = false,
  onPlanLaunch,
  escapeStopsRun = true,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  /**
   * Desktop Escape stops the run when the field is empty (the Stop button's
   * own condition). A salon passes `false`: its stop ends the whole room,
   * too heavy for a key pressed by reflex.
   */
  escapeStopsRun?: boolean;
  botName: string;
  disabled: boolean;
  disabledReason?: string;
  running: boolean;
  /** A send POST in flight: Envoyer greys out, it is not replayed. */
  sending?: boolean;
  /** Bot mode: the bots a `@slug` mention can reach (never the thread's own). */
  mentionables?: MentionableBot[];
  /**
   * The MCP servers the host REALLY serves to runs, by their name. Writing
   * one of them colours the word in the field. A reading aid only: nothing
   * here decides that a tool will be called, the runtime chooses.
   */
  mcpPlugins?: readonly string[];
  /**
   * The draft's attachments (US-CHAT-08). Held by the SCREEN, like the
   * text: it is the screen that knows whether the send succeeded, and therefore when to clear. An
   * internal composer state would clear on send, including when the cloud API
   * refuses and the user should be able to retry.
   */
  attachments?: readonly MessageAttachmentInput[];
  onAttachmentsChange?: (next: MessageAttachmentInput[]) => void;
  /** Identity of the draft: pending reads must never cross conversations. */
  attachmentScope?: string;
  /** The current text or attachments could not be saved in browser storage. */
  draftUnpersisted?: boolean;
  /**
   * The status line under the card (26 px, tertiary text): `statusLeft`
   * on the left, `contextMeter` (context ring and percentage) on the right.
   * Each carries only a real datum; nothing is written without them.
   */
  statusLeft?: ReactNode;
  contextMeter?: ReactNode;
  /** Choice of the next run's model, rendered in the action row. */
  modelControl?: ReactNode;
  /**
   * The status bar hooked to the TOP edge of the shell: what the previous
   * turn occupied of the context, and what runs it. It is one with
   * the card (shared bottom border), so it lives here and not above the
   * composer as a free element: detached, it floated in the middle and no longer
   * read as a property of the composer.
   */
  statusTab?: ReactNode;
  /**
   * The status tab of BoardUI's Composer Panel: hung off the card's top
   * edge, 28 px in from each side, its lower part tucked under the card. It
   * says why the composer is held (the runtime is offline) and carries its
   * own actions, so the disabled surface adds neither tooltip nor tap veil.
   */
  notice?: ReactNode;
  /** Flat quote selected in the thread; it leaves with the next send. */
  replyPreview?: { author: string; text: string } | null;
  onCancelReply?: () => void;
  /** The thread's objective: it precedes each message for as long as it is set. */
  goal?: string | null;
  onSetGoal?: () => void;
  onClearGoal?: () => void;
  /**
   * « Planifier d'abord » (« + » menu): this thread's messages ask for a
   * plan, without touching the bot's mode. Absent: the menu does not offer it.
   */
  planFirst?: boolean;
  onPlanFirstChange?: (next: boolean) => void;
  /** No plugin connected: the menu leads to the integrations. */
  onManagePlugins?: () => void;
  /** Salon: the « + » menu does not offer plugins. */
  showPlugins?: boolean;
  /**
   * A plan card is open: the field corrects the plan, the primary
   * button is Lancer (empty field) rather than Envoyer.
   */
  planPending?: boolean;
  onPlanLaunch?: () => void;
}) {
  const { t, locale } = useT();
  const coarse = useCoarsePointer();
  const mobileDrawer = useMobileDrawer();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Native shell: the field takes focus when the thread becomes available
  // (opening, bot change, gate decided) and on return to the
  // window (`lib/composer/composer-desktop-focus.ts`).
  const nativeShell = isNativeShell();
  useEffect(() => {
    if (nativeShell && !disabled) focusComposerField(textarea.current);
  }, [nativeShell, disabled, botName]);
  useEffect(() => {
    if (!nativeShell) return;
    // Chromium first gives focus back to the last element, then emits `focus`:
    // the decision is made after it.
    const onWindowFocus = () => requestAnimationFrame(() => focusComposerField(textarea.current, "return"));
    window.addEventListener("focus", onWindowFocus);
    return () => window.removeEventListener("focus", onWindowFocus);
  }, [nativeShell]);
  const listId = useId();
  const attachmentCanvas = useAttachmentCanvas();
  const [addOpen, setAddOpen] = useState(false);

  /**
   * Attachments, three entries for a single gesture: the paperclip button, the
   * drop on the pill, the paste from the clipboard. All three
   * go through `addFiles`, therefore through the same bounds and the same named
   * refusals; a pasted capture is not a path of its own.
   */
  const { preparing, pending, errors, addFiles, removeAttachment, clearErrors, hasPending } =
    useComposerAttachments({ attachments, onAttachmentsChange, attachmentScope, disabled, sending });
  // A counter and not a boolean: leaving a child of the pill emits a
  // `dragleave` while one is still over it.
  const [dragDepth, setDragDepth] = useState(0);
  useLayoutEffect(() => setDragDepth(0), [attachmentScope]);

  /**
   * The refusal, told to the user: the file's name AND the reason. A
   * global « fichier invalide » would leave one guessing which of the five is stuck.
   */
  const attachmentErrorText = (error: AttachmentError): string => {
    switch (error.code) {
      case "unsupported":
        return t("composer.attachmentUnsupported", { name: error.name });
      case "too-large":
        return t("composer.attachmentTooLarge", {
          name: error.name,
          size: formatBytes(locale, error.bytes),
          max: formatBytes(locale, ATTACHMENT_LIMITS.maxBytesEach),
        });
      case "too-many":
        return t("composer.attachmentTooMany", { max: String(ATTACHMENT_LIMITS.maxCount) });
      case "unreadable":
        return t("composer.attachmentUnreadable", { name: error.name });
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    // A TEXT paste also carries `items`: divert the event only
    // if there are real files, otherwise pasting text would no longer insert
    // anything into the field.
    const files = [...event.clipboardData.files];
    if (!files.length) return;
    event.preventDefault();
    void addFiles(files);
  };

  /**
   * Bot mode, two typing aids derived from the text AND the caret:
   * - `@…` under the caret opens the list (arrows, Enter/Tab, Escape);
   * - a bare word that starts like a bot (« ne… ») offers « Mentionner
   *   @neo ? », accepted by Tab ONLY. Enter keeps its meaning (send),
   *   otherwise confirming a sentence that contains a bot name would rewrite it.
   */
  const [caret, setCaret] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  // Escape on the list: closed until the next keystroke.
  const [closedTriggerStart, setClosedTriggerStart] = useState<number | null>(null);
  // Escape on the suggestion: silent for as long as one is on that word.
  const [dismissedWordStart, setDismissedWordStart] = useState<number | null>(null);

  const trigger = useMemo(() => findMentionTrigger(value, caret), [value, caret]);
  // Connectors follow the « + » menu rule: none in the salon.
  const atMatches = useMemo(
    () =>
      trigger && trigger.start !== closedTriggerStart
        ? buildMentionOptions(trigger.query, mentionables, showPlugins ? mcpPlugins : EMPTY_MCP_PLUGINS)
        : [],
    [trigger, closedTriggerStart, mentionables, mcpPlugins, showPlugins],
  );
  const atOpen = atMatches.length > 0;
  const word = useMemo(() => (atOpen ? null : findWordAtCaret(value, caret)), [atOpen, value, caret]);
  const plainHint = useMemo(
    () => (word && word.start !== dismissedWordStart ? bestPlainMatch(word.word, mentionables) : null),
    [word, dismissedWordStart, mentionables],
  );
  const activeOption = atMatches[Math.min(activeIndex, atMatches.length - 1)] ?? null;

  /**
   * Highlight of the connected MCP plugins, letter by letter.
   *
   * A `textarea` does not colour a word: the mirror layer placed BEHIND it
   * paints the whole text, and the field erases its own
   * (`data-composer-text="mirrored"`, app.css). What is lost there is rendered
   * elsewhere: the cursor by `caret-color`, the selection by `::selection`
   * which repaints the selected text.
   *
   * One case remains that CSS cannot catch up: IME PRE-EDIT. For as long as
   * a composition is not confirmed, the field shows characters that
   * `value` does not carry yet. The mirror therefore does not know them, and an
   * erased field would make them invisible while one types them. The mirror
   * withdraws for the duration of the composition.
   */
  const [composing, setComposing] = useState(false);
  // The mention chips are that same layer: the field stays a
  // `textarea`, the value stays `@slug` in the clear, only the paint changes.
  const mentionSlugs = useMemo(() => mentionables.map((bot) => bot.slug), [mentionables]);
  const mentionSpans = useMemo(() => mentionRanges(value, mentionSlugs), [value, mentionSlugs]);
  const mirrorSegments = useMemo(() => {
    const base = mcpPlugins.length
      ? segmentMcpPlugins(value, mcpPlugins)
      : value
        ? [{ kind: "text" as const, text: value }]
        : [];
    return markMentions(base, mentionSpans);
  }, [value, mcpPlugins, mentionSpans]);
  const highlightMcp =
    !composing &&
    mirrorSegments.some((segment) => segment.kind === "plugin" || segment.kind === "mention");
  const highlight = useRef<HTMLDivElement>(null);

  // The list opens at the caret (the `@`'s x), not at the card's corner.
  const column = useRef<HTMLDivElement>(null);
  const [menuLeft, setMenuLeft] = useState(0);
  const triggerStart = trigger?.start;
  useLayoutEffect(() => {
    const field = textarea.current;
    const box = column.current;
    if (!atOpen || triggerStart === undefined || !field || !box) return;
    const MENU_WIDTH = 288;
    const x =
      field.getBoundingClientRect().left - box.getBoundingClientRect().left +
      caretOffsetLeft(field, triggerStart) - 8;
    setMenuLeft(Math.max(0, Math.min(x, box.clientWidth - MENU_WIDTH)));
  }, [atOpen, triggerStart, value]);

  const readCaret = (event: SyntheticEvent<HTMLTextAreaElement>) => {
    const element = event.currentTarget;
    setCaret(element.selectionStart ?? element.value.length);
  };

  const accept = (pick: MentionableBot | MentionOption, range: TextRange) => {
    const next = applyMentionPick(value, range, pick);
    onChange(next.text);
    setCaret(next.caret);
    setActiveIndex(0);
    setDismissedWordStart(null);
    // React sets the value back at commit; the caret is replaced after, otherwise it
    // ends up at the end of the text.
    requestAnimationFrame(() => {
      const element = textarea.current;
      if (!element) return;
      element.setSelectionRange(next.caret, next.caret);
      element.focus();
      resize();
    });
  };

  /**
   * Pill (desktop): one row `+` | field | actions as long as the text fits
   * on one line, a card (text at full width, actions underneath) as soon as
   * it asks for a second. The rule is in `lib/composer/composer-pill.ts`;
   * the mobile shell sets its own grid (`mobile.css`) and ignores it.
   */
  const [expanded, setExpanded] = useState(false);
  const shell = useRef<HTMLDivElement>(null);
  // The height and the radius of the pill just before it becomes a card:
  // the spring starts from them (`animateComposerExpand`).
  const expandFrom = useRef<{ height: number; radius: string } | null>(null);
  // True after the first render: an icon mounted afterwards (send, stop,
  // mic) appears as in the reference app, the ones from opening stay still.
  const motionReady = useRef(false);
  useEffect(() => {
    motionReady.current = true;
  }, []);

  const resize = () => {
    const element = textarea.current;
    if (!element) return;
    // Field cleared (after Envoyer, or clearing everything from the keyboard): nothing to
    // measure. `resizeComposerField` sets `height: 0` THEN reads `scrollHeight`,
    // a read that forces a synchronous reflow of the whole document, measured
    // at 308 ms on a thread of ~3500 nodes during the Enter key's commit.
    // `min-h-5` already gives the height of an empty line: the inline
    // height is removed without reading anything.
    if (element.value === "") {
      element.style.height = "";
      element.style.overflowY = "hidden";
      setExpanded(false);
      return;
    }
    const { height } = resizeComposerField(element, composerFieldCeiling(coarse));
    // Once open, the pill stays so until the field is empty: no style read
    // on every keystroke.
    if (!expanded) {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight) || 20;
      const next = nextComposerExpanded(false, { value: element.value, scrollHeight: height }, lineHeight);
      // A single read, and only at the switch: the pill is still there.
      if (next && !coarse && shell.current) {
        expandFrom.current = {
          height: shell.current.getBoundingClientRect().height,
          radius: getComputedStyle(shell.current).borderRadius,
        };
      }
      setExpanded(next);
    }
  };

  // `value` is controlled by the screen. Resizing only in
  // `onChange` happens before the React commit and misses the changes produced
  // by a mention, a draft restore or a programmatic fill.
  // The layout effect measures the value actually rendered, with no flash of a
  // height, then lets the textarea scroll past MAX_HEIGHT.
  // `expanded` too: the card widens the field, its height is remeasured
  // before paint.
  useLayoutEffect(() => {
    resize();
  }, [value, expanded]);

  // Pill → card: the frame follows the reference app's spring (300 ms) instead of
  // jumping. The return to the pill (field cleared, send) stays sharp, as in the reference app.
  useLayoutEffect(() => {
    const from = expandFrom.current;
    expandFrom.current = null;
    if (!expanded || from === null || !shell.current) return;
    animateComposerExpand(shell.current, from);
  }, [expanded]);

  /** What there is to send: text, OR attachments. Attaching a
   *  capture without writing a word is a legitimate send. */
  const empty = !value.trim() && attachments.length === 0;
  // Plan card open, empty field: Lancer, not the Envoyer arrow.
  // Text in the field stays a correction, sent by the arrow.
  const showLaunch = Boolean(planPending && onPlanLaunch) && !running && empty;
  // During a run, a draft replaces Stop with Envoyer: the two actions
  // side by side gave two competing primary buttons and made one
  // believe one had to interrupt before adding an instruction.
  const showSend = !showLaunch && (running ? !empty : true);
  // With no tab and no model (salon), nothing carries `ml-auto`: the button
  // primary then pushes the right group to the end.
  const anchorRight = !statusTab && !modelControl;
  const primaryAnchor = anchorRight && "sm:ml-auto";
  const sendBlocked = disabled || preparing || empty || sending;
  // Shared by the field and its mirror layer, otherwise the layer paints beside it.
  const fieldPadding = expanded ? "sm:px-2.5 sm:pt-2 sm:pb-1" : "sm:px-2";
  // Touch: the send leaves on pointerdown. Without this lock, `click` would replay it.
  const sentOnPointerDown = useRef(false);

  const submit = () => {
    // `preparing` blocks: sending while a file is being read would leave without
    // it, in silence.
    if (sendBlocked || hasPending()) return;
    clearErrors();
    onSubmit();
    // The height does not come back on its own: the content leaves, the inline style stays.
    // Touch: blur AFTER the send. Blur on pointerdown closed the keyboard
    // before the click. The first tap only served to dismiss the keyboard.
    requestAnimationFrame(() => {
      resize();
      if (coarse) releaseComposerKeyboard();
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // `isComposing` protects IME input: without it, confirming a character
    // Japanese would send the message or accept a mention.
    if (event.nativeEvent.isComposing) return;

    if (atOpen && trigger) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((index) => (index + step + atMatches.length) % atMatches.length);
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        // Enter chooses, it does not send: the list is open.
        event.preventDefault();
        if (activeOption) accept(activeOption, trigger);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setClosedTriggerStart(trigger.start);
        return;
      }
    } else if (plainHint && word) {
      if (event.key === "Tab") {
        event.preventDefault();
        accept(plainHint, word);
        return;
      }
      if (event.key === "Escape") {
        setDismissedWordStart(word.start);
        return;
      }
    }

    // A mention chip starts as a block: Backspace right after
    // `@slug` removes the whole token, not one letter (otherwise it stops being one).
    if (event.key === "Backspace" && mentionSpans.length) {
      const field = event.currentTarget;
      if (field.selectionStart === field.selectionEnd) {
        const range = mentionEndingAt(value, field.selectionStart, mentionSlugs);
        if (range) {
          event.preventDefault();
          const next = removeRange(value, range);
          onChange(next.text);
          setCaret(next.caret);
          requestAnimationFrame(() => field.setSelectionRange(next.caret, next.caret));
          return;
        }
      }
    }

    // Desktop: Enter sends. Touch: Enter = newline (no Shift on iOS).
    if (shouldSubmitComposerOnEnter(event, coarse)) {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === "Escape" && replyPreview && onCancelReply) {
      event.preventDefault();
      onCancelReply();
      return;
    }
    // Desktop: Escape stops the run in progress, as every agent composer
    // does (pulseview composer kit, `busy`), but only while the Stop button
    // is the one shown, i.e. the field is empty: Escape inside a draft is
    // not an order to stop. Never on a finger: a soft keyboard has no
    // Escape, and a hardware one on a tablet should not stop a run by surprise.
    if (event.key === "Escape" && running && empty && escapeStopsRun && !coarse) {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <ComposerDisabledSurface disabled={disabled && !notice} reason={disabledReason} coarse={coarse}>
      <div
      data-thread-composer=""
      className="shrink-0 px-4 pt-2 pb-[max(1rem,var(--openedbot-safe-bottom))] sm:p-1"
      >
      <div ref={column} className="relative w-full">
        {atOpen ? (
          <MentionSuggestions
            id={listId}
            left={menuLeft}
            options={atMatches}
            activeIndex={Math.min(activeIndex, atMatches.length - 1)}
            onHover={setActiveIndex}
            onPick={(option) => trigger && accept(option, trigger)}
          />
        ) : plainHint && word ? (
          <p
            role="status"
            aria-live="polite"
            className="absolute bottom-full left-4 mb-1 flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            <span>{t("composer.mentionHint", { slug: plainHint.slug })}</span>
            <kbd className="rounded border border-border px-1 font-mono text-[10px]">
              {t("composer.mentionHintKey")}
            </kbd>
          </p>
        ) : null}
        {draftUnpersisted ? (
          <p role="status" className="mb-1 px-4 text-xs text-destructive-text">
            {t("composer.draftUnpersisted")}
          </p>
        ) : null}
        {errors.length ? (
          <p role="alert" className="mb-1 px-4 text-xs text-destructive-text">
            {errors.map(attachmentErrorText).join(" ")}
          </p>
        ) : null}
        {notice ? (
          // Not positioned on purpose: the card that follows paints its
          // background over the tab's lower padding, which hides under it.
          <div data-composer-notice="" className="mx-7 -mb-3">
            {notice}
          </div>
        ) : null}
        {replyPreview ? <ComposerReplyTab preview={replyPreview} onCancel={onCancelReply} /> : null}
        <div
          ref={shell}
          data-composer-shell=""
          onDragEnter={(event) => {
            if (!onAttachmentsChange || disabled || !event.dataTransfer.types.includes("Files")) return;
            setDragDepth((depth) => depth + 1);
          }}
          onDragOver={(event) => {
            // Without this `preventDefault`, the browser OPENS the dropped file.
            // the tab is replaced by the image and the conversation is lost.
            if (dragDepth > 0) event.preventDefault();
          }}
          onDragLeave={() => setDragDepth((depth) => Math.max(0, depth - 1))}
          onDrop={(event: DragEvent<HTMLDivElement>) => {
            if (!dragDepth) return;
            event.preventDefault();
            setDragDepth(0);
            void addFiles([...event.dataTransfer.files]);
          }}
          className={cn(
            // Measured on streaming-ui.pulseview.app (composer Mention):
            // white card, radius 22, 1 px edge
            // (#ebebeb), `shadow-xs`, padding 8 (7 on desktop: the reference app's pill
            // is 44 px, 28 px actions included). On focus-within the
            // edge takes the hover border and the shadow goes to `shadow-sm`,
            // in 200 ms on `border-color` and `box-shadow`.
            "relative flex flex-col border border-composer-edge bg-background-primary-default p-2 sm:p-[7px] shadow-xs transition-[border-color,box-shadow,background-color] duration-200 focus-within:border-composer-edge-hover focus-within:shadow-sm",
            // All FOUR corners stay rounded, status bar or not:
            // measured on BoardUI, the bar is placed BEHIND the card and
            // sticks out at the top. It is that grey edge at the ends that
            // makes the tab. A card with square top corners no longer reads
            // as a card.
            "rounded-[var(--radius-2-5xl)]",
            // The reference app: the pill is at 22, the card at 18 (on desktop; the
            // mobile shell keeps its shape).
            expanded && "sm:rounded-[18px]",
            // A translucent card would let the tucked-in tab show through it.
            disabled && !notice && "opacity-60",
            dragDepth > 0 && "bg-primary/10",
          )}
        >
          {goal ? (
            <div data-composer-goal="" className="flex min-w-0 items-center gap-2 px-1.5 pt-1">
              <RiFocus3Line className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
              <p className="min-w-0 flex-1 truncate text-body-2-medium text-text-secondary" title={goal}>
                <span className="text-text-primary">{t("boardui.goal")}</span>
                <span className="ms-1.5">{goal}</span>
              </p>
              {onClearGoal ? (
                <button
                  type="button"
                  onPointerDown={keepSoftKeyboard}
                  onClick={onClearGoal}
                  aria-label={t("boardui.clearGoal")}
                  title={t("boardui.clearGoal")}
                  className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-background-tertiary-default text-foreground-icon-secondary outline-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
                >
                  <svg width="8" height="8" viewBox="0 0 10.8 10.8" fill="none" aria-hidden>
                    <path d="M2 2L8.8 8.8M8.8 2L2 8.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>
              ) : null}
            </div>
          ) : null}
          {planFirst ? (
            <div data-composer-plan-first="" className="flex min-w-0 items-center gap-2 px-1.5 pt-1">
              <RiListCheck3 className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
              <p className="min-w-0 flex-1 truncate text-body-2-medium text-text-secondary">
                <span className="text-text-primary">{t("boardui.planFirstOn")}</span>
                <span className="ms-1.5">{t("boardui.planFirstChip", { name: botName })}</span>
              </p>
              {onPlanFirstChange ? (
                <button
                  type="button"
                  onPointerDown={keepSoftKeyboard}
                  onClick={() => onPlanFirstChange(false)}
                  aria-label={t("boardui.clearPlanFirst")}
                  title={t("boardui.clearPlanFirst")}
                  className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-background-tertiary-default text-foreground-icon-secondary outline-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
                >
                  <svg width="8" height="8" viewBox="0 0 10.8 10.8" fill="none" aria-hidden>
                    <path d="M2 2L8.8 8.8M8.8 2L2 8.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>
              ) : null}
            </div>
          ) : null}
          {attachments.length || pending.length ? (
            /* A strip of 56 px tiles, spaced by 8 (composer Mention of the
               streaming-ui kit): accent ring and percentage while
               reading, then the remove button. */
            <ul
              data-composer-attachments=""
              className="flex flex-wrap gap-2 px-1 pt-1 pb-1"
              aria-label={t("composer.attachmentsLabel")}
            >
              {attachments.map((attachment, index) => {
                const image = attachment.kind === "image"
                  ? attachment.content.find(
                      (part): part is Extract<(typeof attachment.content)[number], { type: "image" }> => part.type === "image",
                    )
                  : undefined;
                return (
                  <ComposerAttachmentTile
                    key={`${attachment.name}:${index}`}
                    landed
                    name={attachment.name}
                    image={image?.image}
                    title={`${attachment.name} · ${formatBytes(locale, attachmentBytes(attachment))}`}
                    onRemove={() => removeAttachment(index)}
                    removeLabel={t("composer.attachmentRemove", { name: attachment.name })}
                    open={image && attachmentCanvas
                      ? {
                          label: t("composer.attachmentOpen", { name: attachment.name }),
                          onOpen: () => {
                            releaseComposerKeyboard();
                            attachmentCanvas.open(draftAttachmentCanvasItem(attachment));
                          },
                        }
                      : undefined}
                  />
                );
              })}
              {pending.map((tile) => (
                <ComposerAttachmentTile
                  key={`pending:${tile.batch}:${tile.index}`}
                  name={tile.name}
                  image={tile.image}
                  progress={tile.progress}
                  removeLabel={t("composer.attachmentRemove", { name: tile.name })}
                />
              ))}
            </ul>
          ) : null}
          {/* A single row in the DOM, two lines at the wide render: the
              field takes the full width, the controls move underneath. The
              buttons stay DIRECT children of the row, otherwise the `order`
              of the mobile shell (mobile.css) no longer reaches them. */}
          <div
            data-composer-row=""
            data-composer-expanded={expanded ? "" : undefined}
            className={cn("flex items-end gap-2 sm:items-center sm:gap-1.5", expanded && "sm:flex-wrap sm:gap-y-1")}
          >
            {onAttachmentsChange ? (
              <>
                {/* The real field stays off screen: its native presentation
                    cannot be styled, and it is the button that carries the
                    accessible label. */}
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  accept={ATTACHMENT_ACCEPT}
                  className="hidden"
                  onChange={(event) => {
                    void addFiles([...(event.target.files ?? [])]);
                    // Without this clearing, choosing THE SAME file again would emit
                    // no `change` anymore.
                    event.target.value = "";
                  }}
                />
                {mobileDrawer ? (
                  <Drawer
                    open={addOpen}
                    shouldScaleBackground={false}
                    onOpenChange={(next) => {
                      if (next) haptics.light();
                      setAddOpen(next);
                    }}
                  >
                    <DrawerTrigger asChild>
                      <button
                        data-composer-attachment=""
                        type="button"
                        onPointerDown={keepSoftKeyboard}
                        disabled={disabled || preparing}
                        aria-label={t("composer.addAttachment")}
                        title={t("composer.addAttachment")}
                        className="openedbot-press mb-0.5 flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:opacity-40"
                      >
                        {addOpen
                          ? <svg width="10.8" height="10.8" viewBox="0 0 10.8 10.8" fill="none" aria-hidden><path d="M2 2L8.8 8.8M8.8 2L2 8.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
                          : <RiAddFill className="size-5 transition-transform duration-200" aria-hidden />}
                      </button>
                    </DrawerTrigger>
                    <DrawerContent
                      aria-label={t("boardui.addToChat")}
                      className="border-0 bg-background-primary-default px-3 pb-[max(0.75rem,var(--openedbot-safe-bottom))] text-text-primary"
                      style={{ borderTopLeftRadius: 16, borderTopRightRadius: 16 }}
                    >
                      <DrawerTitle className="sr-only">{t("boardui.addToChat")}</DrawerTitle>
                      <AddMenuBody
                        sheet
                        attachmentsCount={attachments.length}
                        mcpPlugins={mcpPlugins}
                        value={value}
                        onChange={onChange}
                        textareaRef={textarea}
                        fileInput={fileInput}
                        onSetGoal={onSetGoal}
                        planFirst={planFirst}
                        onPlanFirstChange={onPlanFirstChange}
                        onManagePlugins={onManagePlugins}
                        showPlugins={showPlugins}
                        close={() => setAddOpen(false)}
                      />
                    </DrawerContent>
                  </Drawer>
                ) : (
                <BuiPopover open={addOpen} onOpenChange={setAddOpen}>
                  <BuiPopoverTrigger asChild>
                    <button
                      data-composer-attachment=""
                      type="button"
                      onPointerDown={keepSoftKeyboard}
                      disabled={disabled || preparing}
                      aria-label={t("composer.addAttachment")}
                      title={t("composer.addAttachment")}
                      className="openedbot-press mb-0.5 flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:opacity-40 sm:order-1 sm:mb-0 sm:size-7 sm:bg-composer-panel-add-background sm:p-1 sm:text-foreground-icon-primary sm:hover:bg-composer-panel-add-hover-background sm:active:scale-[0.96]"
                    >
                      {addOpen
                        ? <svg width="10.8" height="10.8" viewBox="0 0 10.8 10.8" fill="none" aria-hidden><path d="M2 2L8.8 8.8M8.8 2L2 8.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
                        : <StreamIcon name="plus" className="size-5 transition-transform duration-200" />}
                    </button>
                  </BuiPopoverTrigger>
                  <BuiPopoverContent
                    side="top"
                    align="start"
                    sideOffset={8}
                    className="w-[343px] gap-2"
                    aria-label={t("boardui.addToChat")}
                  >
                    <div className="flex w-full flex-col gap-1.5 pt-1">
                      <BuiSectionLabel>{t("boardui.add")}</BuiSectionLabel>
                      <div className="flex w-full flex-col gap-1">
                        <AddMenuRow
                          icon={RiAttachment2}
                          title={t("boardui.filesAndFolders")}
                          disabled={attachments.length >= ATTACHMENT_LIMITS.maxCount}
                          onSelect={() => { setAddOpen(false); fileInput.current?.click(); }}
                        />
                        {onSetGoal ? (
                          <AddMenuRow
                            icon={RiFocus3Line}
                            title={t("boardui.goal")}
                            hint={t("boardui.goalHint")}
                            onSelect={() => { setAddOpen(false); onSetGoal(); }}
                          />
                        ) : null}
                        {onPlanFirstChange ? (
                          <AddMenuRow
                            icon={RiListCheck3}
                            title={t("boardui.planFirst")}
                            hint={t("boardui.planFirstHint")}
                            checked={planFirst}
                            onSelect={() => { setAddOpen(false); onPlanFirstChange(!planFirst); }}
                          />
                        ) : null}
                      </div>
                    </div>
                    {showPlugins ? <div className="flex w-full flex-col gap-1.5 pt-1">
                      <BuiSectionLabel>{t("boardui.plugins")}</BuiSectionLabel>
                      <div className="flex w-full flex-col gap-1">
                        {mcpPlugins.map((plugin) => (
                          <AddMenuRow
                            key={plugin}
                            leading={<PluginBadge name={plugin} />}
                            title={plugin}
                            hint={t("boardui.pluginHint")}
                            onSelect={() => {
                              setAddOpen(false);
                              const next = value.trim() ? `${value.replace(/\s+$/, "")} ${plugin} ` : `${plugin} `;
                              onChange(next);
                              requestAnimationFrame(() => {
                                const field = textarea.current;
                                if (!field) return;
                                field.focus();
                                field.setSelectionRange(next.length, next.length);
                              });
                            }}
                          />
                        ))}
                        {onManagePlugins ? (
                          <AddMenuRow
                            icon={RiApps2AddLine}
                            title={mcpPlugins.length ? t("boardui.managePlugins") : t("boardui.connectPlugins")}
                            hint={mcpPlugins.length ? undefined : t("boardui.connectPluginsHint")}
                            onSelect={() => { setAddOpen(false); onManagePlugins(); }}
                          />
                        ) : null}
                      </div>
                    </div> : null}
                  </BuiPopoverContent>
                </BuiPopover>
                )}
              </>
            ) : null}
            {statusTab ? (
              <div data-composer-status="" className="hidden min-w-0 sm:order-3 sm:ml-auto sm:flex">
                {statusTab}
              </div>
            ) : null}
            {/* The field is no longer the row's direct child: the mirror
                layer needs a positioned parent. It is therefore THIS node that
                carries the field's place in the mobile bottom bar: order,
                margins (`data-composer-field`, mobile.css). Without it, `order`
                targeted a node that had left the flex context: the paperclip moved
                after the field. */}
            <div
              data-composer-field=""
              className={cn(
                "relative my-1.5 min-w-0 flex-1 sm:my-0",
                // Compact, the field follows the `+` (same `order`, placed after
                // it in the DOM) and precedes the permission.
                expanded ? "sm:order-first sm:basis-full" : "sm:order-1",
                fieldPadding,
              )}
            >
              {highlightMcp ? (
                /* `aria-hidden`: the screen reader reads the field, not its
                   decoration. `pointer-events-none`: the tap goes through to the
                   field, including on a coloured word. */
                <div
                  ref={highlight}
                  aria-hidden
                  data-composer-mcp-highlight=""
                  className={cn("pointer-events-none absolute inset-0 select-none overflow-hidden whitespace-pre-wrap break-words text-body-regular text-text-primary", fieldPadding)}
                >
                  {mirrorSegments.map((segment, index) =>
                    segment.kind === "mention" ? (
                      // A tinted chip on the typed characters: the padding
                      // is taken back by a negative margin, the text's width does not move.
                      <span
                        key={index}
                        data-composer-mention-chip=""
                        className="-mx-[3px] rounded-md bg-violet-500/10 px-[3px] text-violet-700 dark:bg-violet-400/15 dark:text-violet-300"
                      >
                        {segment.text}
                      </span>
                    ) : segment.kind === "plugin" ? (
                      <span
                        key={index}
                        data-composer-mcp-plugin={segment.name}
                        data-composer-mcp-match={segment.match}
                        className={cn(
                          "font-medium",
                          // An approximate name stays a GUESS: it is
                          // underlined, so it does not read as a correct name.
                          segment.match === "approximate" &&
                            "underline decoration-dotted underline-offset-2",
                        )}
                      >
                        {rainbowLetters(segment.text)}
                      </span>
                    ) : (
                      <span key={index}>{segment.text}</span>
                    ),
                  )}
                </div>
              ) : null}
              <textarea
                ref={textarea}
                data-composer=""
                value={value}
                onChange={(event) => {
                  onChange(event.target.value);
                  readCaret(event);
                  setClosedTriggerStart(null);
                  const nextCaret = event.currentTarget.selectionStart ?? event.target.value.length;
                  // The word has changed nature (space, text cleared): the silenced suggestion
                  // may speak again on the next word.
                  if (!findWordAtCaret(event.target.value, nextCaret)) setDismissedWordStart(null);
                  // No `resize()` here: the layout effect above measures the
                  // value ACTUALLY rendered, before paint. Doing it also in
                  // `onChange` doubled the synchronous reflows (`height: 0` then
                  // a read of `scrollHeight`) on every keystroke, without changing anything
                  // in the result.
                }}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                onKeyUp={readCaret}
                onClick={readCaret}
                onSelect={readCaret}
                // The "textbox with autocomplete list" pattern: `aria-controls`
                // + `aria-activedescendant` are enough to announce the list and
                // the active option. No `role="combobox"` and no `aria-expanded`:
                // neither is allowed on a `textarea` (axe:
                // `aria-allowed-role`, `aria-allowed-attr`).
                aria-autocomplete="list"
                aria-controls={atOpen ? listId : undefined}
                aria-activedescendant={atOpen && activeOption ? mentionOptionId(listId, activeOption) : undefined}
                rows={1}
                spellCheck={coarse ? false : undefined}
                enterKeyHint={coarse ? "enter" : "send"}
                disabled={disabled}
                placeholder={
                  disabled && disabledReason
                    ? disabledReason
                    : planPending
                      ? t("planCard.correctPlaceholder")
                      : replyPreview
                        ? t("composer.replyPlaceholder")
                        : coarse
                          // On touch, the bot's name is already in the header:
                          // « Message CTO architecte symfony » ran onto two lines.
                          ? t("mobileComposer.placeholder")
                          : t("composer.messagePlaceholder", { botName })
                }
                aria-label={t("composer.messageAriaLabel", { botName })}
                // `mirrored`: the field erases its text and lets the layer
                // paint it (colour, cursor and selection: app.css). The attribute
                // is set ONLY for as long as a plugin name is on screen.
                data-composer-text={highlightMcp ? "mirrored" : undefined}
                // An IME composition shows characters that `value` does not
                // carry yet: the layer withdraws, the field takes its text back.
                // `onKeyDown` already has its own `isComposing` guard.
                onCompositionStart={() => setComposing(true)}
                onCompositionEnd={() => setComposing(false)}
                className="no-scrollbar relative block max-h-[200px] min-h-5 w-full resize-none overflow-hidden bg-transparent p-0 text-body-regular text-text-primary caret-accent-500 outline-none placeholder:text-text-tertiary [&:placeholder-shown]:truncate"
                // Past the ceiling the field scrolls: without this carry-over, the backgrounds
                // stayed at the top while the text scrolled.
                onScroll={(event) => {
                  const layer = highlight.current;
                  if (layer) layer.scrollTop = event.currentTarget.scrollTop;
                }}
              />
            </div>

            {/* The right group starts here: `ml-auto` pushes it to the end of
                the second line. On the mobile shell, the wrapper has no
                `order` of its own, exactly like the node it replaces. */}
            {modelControl ? (
              <div data-composer-model="" className={cn("contents sm:order-4 sm:me-2 sm:block", !statusTab && "sm:ml-auto")}>
                {modelControl}
              </div>
            ) : null}

            {running && empty ? (
              <button
                data-composer-action="stop"
                data-composer-stop-action=""
                data-composer-primary-action=""
                type="button"
                onPointerDown={keepSoftKeyboard}
                onClick={onCancel}
                className={cn("openedbot-press mb-0.5 flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full bg-background-tertiary-default text-foreground-icon-primary outline-none transition-colors hover:bg-background-tertiary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring sm:order-6 sm:mb-0 sm:size-7", primaryAnchor)}
                aria-label={t("composer.stopGeneration")}
                aria-keyshortcuts={coarse || !escapeStopsRun ? undefined : "Escape"}
                title={coarse || !escapeStopsRun ? undefined : t("composer.stopGenerationShortcut")}
              >
                <SwapIcon ready={motionReady}>
                  <Square className="size-3.5 fill-current" />
                </SwapIcon>
              </button>
            ) : null}
            {showLaunch ? (
              <button
                data-composer-action="launch"
                data-composer-primary-action=""
                data-plan-launch=""
                type="button"
                onPointerDown={keepSoftKeyboard}
                onClick={onPlanLaunch}
                disabled={disabled || preparing || sending}
                className={cn("openedbot-press bg-button-primary mb-0.5 flex h-11 min-h-11 shrink-0 cursor-pointer items-center justify-center rounded-full px-3.5 text-[15px] font-semibold text-white outline-none transition-opacity duration-200 focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40 sm:order-6 sm:mb-0 sm:h-7 sm:min-h-7 sm:px-2.5 sm:text-[13px]", primaryAnchor)}
                aria-label={t("planCard.launch")}
              >
                {t("planCard.launch")}
              </button>
            ) : null}
            {showSend ? (
              <button
                data-composer-action="send"
                data-composer-primary-action=""
                data-composer-send-action=""
                type="button"
                onPointerDown={(event) => {
                  keepSoftKeyboard(event);
                  if (!shouldSendComposerOnPointerDown(coarse)) return;
                  sentOnPointerDown.current = true;
                  submit();
                }}
                onClick={() => {
                  if (sentOnPointerDown.current) {
                    sentOnPointerDown.current = false;
                    return;
                  }
                  submit();
                }}
                disabled={sendBlocked}
                className={cn("openedbot-press bg-button-primary mb-0.5 flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full p-2 text-white outline-none transition-[opacity,scale] duration-200 focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-30 sm:order-6 sm:mb-0 sm:size-7 sm:p-1 sm:active:scale-95", primaryAnchor)}
                aria-label={planPending ? t("planCard.sendCorrection") : t("composer.send")}
              >
                <SwapIcon ready={motionReady}>
                  <StreamIcon name="arrowUp" className="size-4 sm:size-5" />
                </SwapIcon>
              </button>
            ) : null}
          </div>
        </div>
        {statusLeft || contextMeter ? (
          // The line under the card (composer Mention): 26 px, tertiary text,
          // 16 px icons, one real fact on each side.
          <div
            data-composer-statusline=""
            className="flex h-[26px] items-center justify-between gap-3 px-2 text-body-2-medium text-text-tertiary [&_svg]:size-4"
          >
            {statusLeft ?? <span />}
            <span className="flex min-w-0 items-center gap-2">{contextMeter}</span>
          </div>
        ) : null}
      </div>
      </div>
    </ComposerDisabledSurface>
  );
}

function AddMenuBody({
  sheet,
  attachmentsCount,
  mcpPlugins,
  value,
  onChange,
  textareaRef,
  fileInput,
  onSetGoal,
  planFirst,
  onPlanFirstChange,
  onManagePlugins,
  showPlugins,
  close,
}: {
  sheet?: boolean;
  attachmentsCount: number;
  mcpPlugins: readonly string[];
  value: string;
  onChange: (next: string) => void;
  textareaRef: { current: HTMLTextAreaElement | null };
  fileInput: { current: HTMLInputElement | null };
  onSetGoal?: () => void;
  planFirst: boolean;
  onPlanFirstChange?: (next: boolean) => void;
  onManagePlugins?: () => void;
  showPlugins: boolean;
  close: () => void;
}) {
  const { t } = useT();
  const row = sheet ? "min-h-11" : undefined;
  return (
    <>
      <div className="flex w-full flex-col gap-1.5 pt-1">
        <BuiSectionLabel>{t("boardui.add")}</BuiSectionLabel>
        <div className="flex w-full flex-col gap-1">
          <AddMenuRow
            className={row}
            icon={RiAttachment2}
            title={t("boardui.filesAndFolders")}
            disabled={attachmentsCount >= ATTACHMENT_LIMITS.maxCount}
            onSelect={() => { close(); fileInput.current?.click(); }}
          />
          {onSetGoal ? (
            <AddMenuRow className={row} icon={RiFocus3Line} title={t("boardui.goal")} hint={t("boardui.goalHint")} onSelect={() => { close(); onSetGoal(); }} />
          ) : null}
          {onPlanFirstChange ? (
            <AddMenuRow
              className={row}
              icon={RiListCheck3}
              title={t("boardui.planFirst")}
              hint={t("boardui.planFirstHint")}
              checked={planFirst}
              onSelect={() => { close(); onPlanFirstChange(!planFirst); }}
            />
          ) : null}
        </div>
      </div>
      {showPlugins ? <div className="flex w-full flex-col gap-1.5 pt-1">
        <BuiSectionLabel>{t("boardui.plugins")}</BuiSectionLabel>
        <div className="flex w-full flex-col gap-1">
          {mcpPlugins.map((plugin) => (
            <AddMenuRow
              key={plugin}
              className={row}
              leading={<PluginBadge name={plugin} />}
              title={plugin}
              hint={t("boardui.pluginHint")}
              onSelect={() => {
                close();
                const next = value.trim() ? `${value.replace(/\s+$/, "")} ${plugin} ` : `${plugin} `;
                onChange(next);
                requestAnimationFrame(() => {
                  const field = textareaRef.current;
                  if (!field) return;
                  field.focus();
                  field.setSelectionRange(next.length, next.length);
                });
              }}
            />
          ))}
          {onManagePlugins ? (
            <AddMenuRow
              className={row}
              icon={RiApps2AddLine}
              title={mcpPlugins.length ? t("boardui.managePlugins") : t("boardui.connectPlugins")}
              hint={mcpPlugins.length ? undefined : t("boardui.connectPluginsHint")}
              onSelect={() => { close(); onManagePlugins(); }}
            />
          ) : null}
        </div>
      </div> : null}
    </>
  );
}

/** A row of the « + » menu: 20 px icon, title, then the help in grey on the same line. */
function AddMenuRow({
  icon: Icon,
  leading,
  title,
  hint,
  disabled,
  checked,
  onSelect,
  className,
}: {
  icon?: ComponentType<{ className?: string }>;
  leading?: ReactNode;
  title: string;
  hint?: string;
  disabled?: boolean;
  /** A switch row: pressed while on, with a check at the end. */
  checked?: boolean;
  onSelect: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={checked === undefined ? undefined : checked}
      onClick={onSelect}
      className={cn(BUI_PANEL_ITEM, "active:bg-background-primary-hover", className)}
    >
      {leading ?? (Icon ? <Icon className="size-5 shrink-0 text-foreground-icon-secondary" /> : null)}
      <span className="min-w-0 flex-1 truncate text-body-medium whitespace-nowrap">
        <span className="text-text-primary">{title}</span>
        {hint ? <span className="ms-1.5 text-text-secondary">{hint}</span> : null}
      </span>
      {checked ? <RiCheckLine className="size-4 shrink-0 text-text-primary" aria-hidden /> : null}
    </button>
  );
}

/**
 * The primary button's icon as it changes (send, stop, mic) goes from
 * 0.5 to 1 in 200 ms, like the reference app. Decided at mount (`useState`): an
 * icon already there never replays the animation on a later render.
 */
function SwapIcon({ ready, children }: { ready: RefObject<boolean>; children: ReactNode }) {
  const [swap] = useState(() => ready.current === true);
  return <span className={cn("relative inline-flex", swap && "openedbot-icon-swap")}>{children}</span>;
}
