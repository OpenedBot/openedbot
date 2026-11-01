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
import { useThreadEditAvailability } from "../lib/thread-edit-availability";
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
import { haptics } from "../lib/haptics";
import { RiFileCopyLine, RiMoreFill, RiThumbDownLine, RiThumbUpLine } from "@remixicon/react";
import { BUI_MENU_ITEM, BUI_POPOVER, BuiContextMenu, BuiContextMenuContent, BuiContextMenuItem, BuiContextMenuTrigger } from "./boardui/menu";

export type MessageInteractionLabels = {
  reply: string;
  helpful: string;
  unhelpful: string;
  copyResponse: string;
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
  /** Clic droit : l'identifiant du message, pour le support. */
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
  /** Texte du tour entier, quand la barre ferme un tour coupé par des outils. */
  copyText?: string | null;
  /** Les réactions du tour : l'état des boutons « utile » / « inutile ». */
  reactions?: readonly MessageReactionDto[];
};

const ACTION =
  "flex size-[22px] items-center justify-center rounded-md bg-background-tertiary-default text-foreground-icon-tertiary outline-none transition-colors hover:text-foreground-icon-secondary focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:opacity-50 aria-pressed:text-foreground-icon-primary";

/**
 * The action row under an answer (reference: 28 px buttons, 16 px icons,
 * tertiary tone, primary on hover, a quiet fill under the pointer).
 */
const BELOW_ACTION =
  "grid size-7 shrink-0 place-items-center rounded-md text-foreground-icon-tertiary outline-none transition-colors hover:bg-background-tertiary-hover hover:text-foreground-icon-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:opacity-50 aria-pressed:text-foreground-icon-primary motion-reduce:transition-none";

/** Les deux avis du template BoardUI : utile, inutile. Exclusifs. */
const HELPFUL: MessageReactionEmoji = "👍";
const UNHELPFUL: MessageReactionEmoji = "👎";

/** Durée d'un appui long : celle de `Pressable` / du menu contextuel iOS. */
const LONG_PRESS_MS = 450;
/** Au-delà, le doigt fait défiler la liste : ce n'est plus un appui. */
const LONG_PRESS_SLOP = 10;
/** Fenêtre pendant laquelle le clic synthétisé par la levée du doigt est ignoré. */
const GHOST_CLICK_MS = 700;

/**
 * L'appui long qui remplace le survol sur un écran tactile.
 *
 * Sur un téléphone, la rangée d'icônes de survol était forcée visible en
 * permanence : trois pastilles de 28 px collées à CHAQUE bulle, qui volaient
 * 5,5 rem de largeur au texte et désalignaient la colonne. Aucune messagerie
 * native ne fait cela : les actions d'un message s'y obtiennent en le gardant
 * appuyé, et arrivent en feuille ancrée en bas.
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
      // La souris garde le survol ; seul le doigt (ou le stylet) déclenche.
      if (!event.isPrimary || event.pointerType === "mouse") return;
      origin.current = { x: event.clientX, y: event.clientY };
      timer.current = window.setTimeout(() => {
        timer.current = null;
        // Le doigt est encore posé : en le levant, le moteur synthétise un
        // `click` aux mêmes coordonnées, qui tomberait sur le voile de la
        // feuille tout juste montée et la refermerait aussitôt. On avale ce
        // clic fantôme : le même piège que le « ghost click » d'iOS.
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
    // Sans cela, WebKit ouvre SA fiche de sélection par-dessus la feuille.
    onContextMenu: (event) => event.preventDefault(),
  };
}

const PICKER_H = 40;
const PICKER_W = 232;
/** Composer + label modèle : le picker in-flow tombait derrière / sous le fold. */
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
 * Le clic droit garde le menu du navigateur là où il sert : une sélection de
 * texte (copier, rechercher), un lien, une image, un champ. Arrêté en capture,
 * l'événement n'atteint pas le déclencheur Radix, qui sinon l'annulerait.
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
  /** Barre `below` : ce qui précède les actions sur la même ligne (l'auteur). */
  footerStart?: ReactNode;
  /** Contexte visuel placé au-dessus du message, hors de la zone qui ancre
   * les actions hover. Une question répondue ne doit pas élargir la bulle. */
  context?: ReactNode;
  messageId?: string | null;
  replyTo?: MessageReplyPreview | null;
  reactions?: readonly MessageReactionDto[];
  align: "start" | "end";
  /** `fill` pour un article : plus de plafond 85 %, la prose prend la colonne. */
  width?: "fit" | "fill";
  /**
   * `full` : bulle + hover + quote/réactions.
   * `chrome` : quote/réactions seulement (les cards portent le hover).
   * `card` : une card de la pile, hover seul.
   */
  surface?: MessageSurface;
  /**
   * `side` : la rangée de survol à côté de la bulle (messagerie).
   * `below` : une barre sous la réponse, copier et lecture en premier plan :
   * la forme d'AI Elements / prompt-kit pour une réponse longue à plat, où
   * une rangée collée au bord droit de 72 ch flotterait dans le vide.
   * `menu` : rien autour de la bulle, comme le fil de Grok Bot ; les gestes
   * passent par le clic droit (souris) ou l'appui long (doigt).
   */
  actions?: "side" | "below" | "menu";
  /** Barre `below` toujours visible (dernière réponse), pas seulement au survol. */
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
  // Doigt : rien à côté de la bulle, tout dans la feuille d'appui long.
  const coarse = useCoarsePointer();
  const inlineActions = interactive && !coarse;
  const below = actions === "below" && inlineActions;
  const side = actions === "side" && inlineActions;
  const touchActions = interactive && coarse;
  // PWA tactile : la réponse IA complète (`surface="chrome"`) garde deux
  // actions visibles sous son contenu. Les bulles opérateur (`align="end"`)
  // et les cartes internes restent sans barre permanente.
  const touchAssistantActions = coarse && surface === "chrome" && align === "start" && canCopy;
  // Souris : le clic droit sur la bulle ouvre les mêmes gestes, comme Grok
  // Bot (réactions en tête, puis répondre, copier…). Le doigt garde l'appui long.
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
  /** Utile et inutile s'excluent : poser l'un retire l'autre. */
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
              {/* Sans barre autour, la bulle porte le focus : la touche Menu
                  (ou Maj+F10) y ouvre les mêmes gestes, comme chez Grok Bot. */}
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
                "-ms-1 flex shrink-0 items-center gap-0.5 pt-1 transition-opacity duration-200",
                actionsReveal && "ohb-fade-up",
                persistentActions ? "opacity-100" : "opacity-0 group-hover/reply:opacity-100 group-hover/message:opacity-100 group-focus-within/message:opacity-100",
                (pickerOpen || menuOpen) && "opacity-100",
              )}
            >
              {canReact && messageId ? (
                <>
                  <button
                    type="button"
                    aria-label={labels.helpful}
                    title={labels.helpful}
                    aria-pressed={reacted(HELPFUL)}
                    disabled={pendingEmoji !== null}
                    onClick={() => void toggleVerdict(HELPFUL)}
                    className={BELOW_ACTION}
                  >
                    <RiThumbUpLine className="size-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    aria-label={labels.unhelpful}
                    title={labels.unhelpful}
                    aria-pressed={reacted(UNHELPFUL)}
                    disabled={pendingEmoji !== null}
                    onClick={() => void toggleVerdict(UNHELPFUL)}
                    className={BELOW_ACTION}
                  >
                    <RiThumbDownLine className="size-4" aria-hidden />
                  </button>
                </>
              ) : null}
              {canCopy ? (
                <button
                  type="button"
                  aria-label={copyState === "copied" ? labels.copied : labels.copyResponse}
                  title={copyState === "copied" ? labels.copied : labels.copyResponse}
                  onClick={() => void copy()}
                  className={BELOW_ACTION}
                >
                  {copyState === "copied"
                    ? <Check className="size-4" aria-hidden />
                    : <RiFileCopyLine className="size-4" aria-hidden />}
                </button>
              ) : null}
              {canReact || canReply || canEdit || canRegenerate || speaker ? (
                <div ref={pickerRef} className="relative">
                  <DropdownMenu
                    open={menuOpen}
                    onOpenChange={(open) => {
                      if (open) setPickerOpen(false);
                      setMenuOpen(open);
                    }}
                  >
                    <DropdownMenuTrigger asChild>
                      <button type="button" aria-label={labels.more} title={labels.more} className={BELOW_ACTION}>
                        <RiMoreFill className="size-4" aria-hidden />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className={cn(BUI_POPOVER, "min-w-[198px] gap-1")}>
                      {canReact && messageId ? (
                        <div role="group" aria-label={labels.react} className="flex items-center gap-0.5 px-1 pb-1">
                          {MESSAGE_REACTION_EMOJIS.filter((emoji) => emoji !== HELPFUL && emoji !== UNHELPFUL).map((emoji) => {
                            const active = reacted(emoji);
                            return (
                              <DropdownMenuItem
                                key={emoji}
                                aria-label={active ? `${labels.removeReaction} ${emoji}` : `${labels.react} ${emoji}`}
                                onSelect={() => void toggle(emoji, active)}
                                className={cn("flex size-8 cursor-pointer items-center justify-center rounded-2lg p-0 text-base outline-none data-[highlighted]:bg-dropdown-item-hover-background", active && "bg-background-tertiary-default")}
                              >
                                {emoji}
                              </DropdownMenuItem>
                            );
                          })}
                        </div>
                      ) : null}
                      {canReply && messageId ? (
                        <DropdownMenuItem className={BUI_MENU_ITEM} onSelect={() => onReply?.(messageId, copyText ?? undefined)}>
                          <Reply className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
                          {labels.reply}
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
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
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
            className="ohb-press flex h-11 w-8 items-center justify-center rounded-lg text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
            className="ohb-press flex h-11 w-8 items-center justify-center rounded-lg text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
 * Les actions d'un message, en feuille ancrée en bas : la présentation modale
 * native d'un téléphone. `Dialog` la rend déjà ainsi sous 640 px : poignée,
 * coins hauts arrondis, montée depuis le bas, rembourrage de zone sûre.
 *
 * Réactions en haut, en une rangée de 44 pt ; puis la liste groupée iOS :
 * 48 pt par ligne, icône à gauche, filet entre les lignes.
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
  /** `null` quand ce message n'accepte pas de réaction : pas de rangée vide. */
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
                  "ohb-press flex size-11 flex-1 items-center justify-center rounded-xl text-2xl leading-none outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
                className="ohb-press flex min-h-12 w-full items-center gap-3 px-4 text-left text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
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
