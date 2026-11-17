import { memo, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { MessageAuthorBot } from "@openedbot/contracts-api";
import { segmentMentions } from "@openedbot/roster/domain/mentions";
import { Check, Copy } from "lucide-react";
import { useT } from "../lib/i18n";
import { useThreadEditAvailability } from "../lib/thread/thread-edit-availability";
import { StreamIcon } from "./stream/stream-icons";
import { stabilizeStreamingMarkdown } from "../lib/stream/streaming-markdown";
import { useSmoothText } from "../lib/stream/use-smooth-text";
import type { MessageAttachmentChip } from "./attachment-canvas";
import { BotFace } from "./bot-face";
import { MessageInteractionShell, type MessageCardHover } from "./message-interactions";
import { type RunTiming } from "../lib/run/run-timing";
import { RunTimingBadge } from "./run-timing";
import { AttachmentTile } from "./thread-attachment-tile";
import { ThreadMarkdown } from "./thread-markdown";
import { modelUnavailableMessage } from "../lib/run/model-unavailable";
import { useOpenSettings } from "../lib/shell/settings-overlay";
import { providerLabel } from "./provider-icon";
import { requestProviderReconnect } from "../lib/runtime/provider-auth";

/**
 * The failure of a turn whose provider refused the bot's login
 * (`PROVIDER_AUTH_REQUIRED`). The worker no longer hands such a turn to
 * another provider: the bubble names the provider and opens Models on that
 * provider's connection dialog, where the operator reconnects it.
 */
export function ProviderAuthNotice({
  name,
  provider,
  findTargetId,
  findActive = false,
}: {
  name: string;
  provider: string;
  findTargetId: string;
  findActive?: boolean;
}) {
  const { t } = useT();
  const openSettings = useOpenSettings();
  const label = providerLabel(provider);
  return (
    <div
      role="alert"
      data-provider-auth-required={provider}
      data-thread-find-target={findTargetId}
      className={`flex max-w-[85%] flex-col items-start gap-1.5 self-start rounded-2xl rounded-bl-md bg-destructive px-3.5 py-2.5 text-sm font-medium text-white ${findActive ? "ring-2 ring-primary ring-offset-2" : ""}`}
    >
      <p>{t("threadTimeline.providerAuthRequired", { name, provider: label })}</p>
      <button
        type="button"
        onClick={() => {
          requestProviderReconnect(provider);
          openSettings("/settings/models");
        }}
        className="cursor-pointer underline underline-offset-2 outline-none hover:no-underline focus-visible:ring-2 focus-visible:ring-white"
      >
        {t("threadTimeline.providerAuthRequiredAction", { provider: label })}
      </button>
    </div>
  );
}

/**
 * The failure of a turn whose provider refuses the model (`MODEL_UNAVAILABLE`).
 * In place of the raw « HTTP 400 », a sentence that names the member and the model,
 * and the action that fixes it: the bot's conversation carries the model
 * picker. Without a `botId` (legacy mail), the message stays, the action is missing.
 */
export function ModelUnavailableNotice({
  name,
  model,
  botId,
  findTargetId,
  findActive = false,
}: {
  name: string;
  model: string | null;
  botId: string | null;
  findTargetId: string;
  findActive?: boolean;
}) {
  const { t } = useT();
  return (
    <div
      role="alert"
      data-model-unavailable={botId ?? ""}
      data-thread-find-target={findTargetId}
      className={`flex max-w-[85%] flex-col items-start gap-1.5 self-start rounded-2xl rounded-bl-md bg-destructive px-3.5 py-2.5 text-sm font-medium text-white ${findActive ? "ring-2 ring-primary ring-offset-2" : ""}`}
    >
      <p>{modelUnavailableMessage(t, name, model)}</p>
      {botId ? (
        <Link
          to="/bot/$botId"
          params={{ botId }}
          className="underline underline-offset-2 outline-none hover:no-underline focus-visible:ring-2 focus-visible:ring-white"
        >
          {t("threadTimeline.modelUnavailableAction")}
        </Link>
      ) : null}
    </div>
  );
}

/** Dev only: the real duration on the reply's action row (the reference app shows nothing). */
const SHOW_RUN_TIMING = import.meta.env.DEV === true;

/**
 * An assistant message.
 *
 * `memo` is useful ONLY because the stream hook preserves identities: the
 * snapshot is mutated by `applyProductEventToSnapshot`, which recreates only
 * the event that changes. Without that, every delta would reparse all the markdown
 * of the thread.
 */
export const AssistantMessage = memo(function AssistantMessage({
  text: targetText,
  runId,
  attachments,
  author,
  streaming = false,
  timing = null,
  showTiming = SHOW_RUN_TIMING,
  findTargetId,
  findActive = false,
  hover,
}: {
  text: string;
  runId?: string;
  attachments?: readonly MessageAttachmentChip[];
  /** The bubble's author: face + name, like a message relayed from another bot. */
  author?: MessageAuthorBot | null;
  /**
   * True for the active run's bubble: its growth smooths character by
   * character (`useSmoothText`) instead of jumping in 500 ms SSE bursts.
   */
  streaming?: boolean;
  /** The run's real duration, once finished: after the action row's « … », in dev. */
  timing?: RunTiming | null;
  /** Dev builds only (`SHOW_RUN_TIMING`); a prop so tests can reach both layouts. */
  showTiming?: boolean;
  findTargetId: string;
  findActive?: boolean;
  hover?: MessageCardHover;
}) {
  const text = useSmoothText(targetText, streaming);
  const markdown = streaming || text !== targetText
    ? stabilizeStreamingMarkdown(text)
    : text;
  // the reference app's agent bubble (fill, sheen and edge in `thread-theme.css`):
  // Radius 18, padding 7 / 12; the action shell bounds the available width.
  // Inside, the reference app's `Answer` typography (`data-assistant-layout="stream"`);
  // every streamed word blurs in (`.stream-w`).
  const surface = (
    <div
      data-thread-find-target={author || hover ? undefined : findTargetId}
      data-assistant-layout="stream"
      tabIndex={-1}
      className={`w-full min-w-0 self-start rounded-[18px] px-3 py-[7px] ${findActive ? "ring-2 ring-border-focus-ring ring-offset-2" : ""}`}
    >
      {/* `wrap-anywhere`: an endless URL (Google News RSS links…) must
          break inside the reply, never widen the thread into a horizontal scroll. */}
      <div data-assistant-text="" className="prose max-w-none wrap-anywhere text-[15px] leading-[22.5px] prose-code:before:content-none prose-code:after:content-none">
        <ThreadMarkdown streaming={streaming}>{markdown}</ThreadMarkdown>
      </div>
    </div>
  );
  const body = hover ? (
    <MessageInteractionShell
      surface="card"
      width="fill"
      actions="side"
      messageId={hover.messageId}
      align="start"
      labels={hover.labels}
      copyText={hover.copyText ?? markdown}
      reactions={hover.reactions}
      onReply={hover.onReply}
      onReaction={hover.onReaction}
      speaker={hover.speakerFor?.("body", hover.copyText ?? markdown)}
      // Keep timing inside the hover actions so it is hidden with them.
      footerEnd={showTiming && timing ? <span data-run-timing=""><RunTimingBadge timing={timing} /></span> : undefined}
    >
      {surface}
    </MessageInteractionShell>
  ) : surface;
  return (
    <article
      tabIndex={-1}
      data-turn-of={author?.id}
      data-thread-find-target={author || hover ? findTargetId : undefined}
      className={`group/reply flex w-full max-w-full flex-col items-start self-start text-body-regular ${findActive ? "rounded-[var(--radius-2-5xl)] ring-2 ring-border-focus-ring ring-offset-2" : ""}`}
    >
      <div data-assistant-response="" data-run-id={runId} className="flex w-full min-w-0 flex-col items-start">
        {body}
      </div>
      {attachments?.length ? (
        <ul className="mt-1.5 flex flex-wrap gap-1.5">
          {attachments.map((attachment, index) => (
            <li key={attachment.id ?? `${attachment.name}:${index}`}>
              <AttachmentTile attachment={attachment} />
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
});

/** A scheduled answer is identified without posing as the operator. */
export function RoutineStamp({ at }: { at?: string }) {
  const { t, formatDate } = useT();
  return (
    <div data-routine-stamp="" role="separator" aria-label={t("botRoutinesDialog.routineBadge")} className="flex flex-wrap items-center gap-2 self-center justify-center px-1 py-3 text-xs text-muted-foreground">
      {at ? <time dateTime={at}>{formatDate(at, { weekday: "long", hour: "numeric", minute: "2-digit" })}</time> : null}
      <span className="rounded-full bg-info-soft px-2.5 py-1 font-medium text-info-700">{t("botRoutinesDialog.routineBadge")}</span>
    </div>
  );
}

/**
 * A team card: the consecutive replies of several members of a
 * salon. Each text keeps ITS bubble: the action row lives below, at the
 * right edge, like a reply alone. The synthesis does not repeat the bot
 * (`thread-timeline.css`). The contributions, though, name it: they
 * open by default, and one can fold them.
 */
export function RoomAnswerCard({
  authors,
  synthesis,
  children,
}: {
  authors: readonly MessageAuthorBot[];
  /** Team mode: the final reply, rendered at the head. */
  synthesis: React.ReactNode[] | null;
  children: React.ReactNode[];
}) {
  const { t } = useT();
  const [contributionsOpen, setContributionsOpen] = useState(true);
  const names = authors.map((author) => author.name ?? author.slug ?? t("threadTimeline.unknownBot"));
  return (
    <section
      data-room-answer=""
      aria-label={t("threadTimeline.roomAnswer", { names: names.join(", ") })}
      className="flex w-full min-w-0 flex-col self-start"
    >
      {synthesis ? (
        <>
          <div data-room-synthesis="" className="flex min-w-0 flex-col">{synthesis}</div>
          {children.length ? (
            <details
              data-room-contributions=""
              className="mt-2 min-w-0"
              open={contributionsOpen}
              onToggle={(event) => setContributionsOpen(event.currentTarget.open)}
            >
              <summary className="cursor-pointer text-body-2-medium text-text-secondary">
                {t("threadTimeline.roomContributions", { count: children.length })}
              </summary>
              <div className="mt-2 flex min-w-0 flex-col">{children}</div>
            </details>
          ) : null}
        </>
      ) : (
        <div className="flex min-w-0 flex-col">{children}</div>
      )}
    </section>
  );
}

export const UserMessage = memo(function UserMessage({
  text,
  attachments,
  steeredIntoActive = false,
  steeredIntoSettled = false,
  mentionSlugs,
  findTargetId,
  findActive = false,
  onEdit,
}: {
  text: string;
  /**
   * US-CHAT-08: what the thread keeps of an attachment: its identity, never
   * its payload (it went to the runtime in the run's prompt). A chip
   * with no preview is the honest price of not storing the images.
   */
  attachments?: readonly MessageAttachmentChip[];
  /** The fallback run was absorbed by the run that was already writing. */
  steeredIntoActive?: boolean;
  /** Absorbed by a run that has rendered since: nothing is « en cours » anymore. */
  steeredIntoSettled?: boolean;
  mentionSlugs: ReadonlySet<string>;
  findTargetId: string;
  findActive?: boolean;
  /** Rewrite this message (the reference app's « Modifier » under the bubble). */
  onEdit?: () => void;
}) {
  const { t } = useT();
  const segments = segmentMentions(text, mentionSlugs);
  const editAllowed = useThreadEditAvailability((state) => state.canEdit);
  return (
    // The user's turn: the bubble is at most 560 px (the reference app) inside the
    // 85 % cap the interaction shell around it already sets (`max-w-[85%]`).
    <div
      data-thread-find-target={findTargetId}
      tabIndex={-1}
      className={`flex max-w-full flex-col items-end gap-1.5 self-end ${findActive ? "rounded-2xl ring-2 ring-primary ring-offset-2" : ""}`}
    >
      {attachments?.length ? (
        <ul className="flex flex-wrap justify-end gap-1.5">
          {/* The key falls back to the index when the `id` is missing: the attachments
              written before files were stored have none, and an
              `undefined` key is a list React can no longer reconcile. */}
          {attachments.map((attachment, index) => (
            <li key={attachment.id ?? `${attachment.name}:${index}`}>
              <AttachmentTile attachment={attachment} />
            </li>
          ))}
        </ul>
      ) : null}
      {/* An empty bubble under the chips would read as a lost message:
          attaching without writing a word renders none. */}
      {/* the reference app's bubble: radius 18, 7 × 12, 15/22, 560 px at most;
          the fill (neutral or the bot's colour) in `thread-theme.css`. */}
      {text ? (
        // The actions hang beside the bubble without taking a line of their own:
        // in flow they reserved 34 px under every sent message.
        <div data-user-bubble-row="" className="relative flex max-w-full flex-col items-end">
          <div
            data-user-bubble=""
            className="w-fit max-w-[min(560px,100%)] whitespace-pre-wrap break-words rounded-[18px] px-3 py-[7px] text-start text-[15px] leading-[22px]"
          >
            {segments.map((segment, index) =>
              segment.kind === "mention" ? (
                // A TEXT accent, never a fill: the bubble already carries a background.
                // On the fill (the bot's colour or ink), the mention keeps the colour
                // of the text, underlined and semi-bold (`thread-theme.css`).
                <span
                  key={index}
                  data-mention={segment.slug}
                  className="font-semibold"
                >
                  {segment.raw}
                </span>
              ) : (
                segment.text
              ),
            )}
          </div>
          <UserTurnActions text={text} onEdit={editAllowed ? onEdit : undefined} />
        </div>
      ) : null}
      {steeredIntoActive || steeredIntoSettled ? (
        <p className="px-1 text-xs text-muted-foreground">
          {t(steeredIntoActive ? "threadTimeline.steeredIntoActive" : "threadTimeline.steeredIntoSettled")}
        </p>
      ) : null}
    </div>
  );
});

/** the reference app's `UserTurn` row: « Modifier » and « Copier », 32 px, shown while the pointer is on the message. */
function UserTurnActions({ text, onEdit }: { text: string; onEdit?: () => void }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_200);
    } catch {
      setCopied(false);
    }
  };
  const button = "grid size-8 place-items-center rounded-full text-[var(--stream-fg2)] outline-none transition-colors hover:bg-[var(--stream-hover)] hover:text-[var(--stream-fg)] focus-visible:ring-2 focus-visible:ring-border-focus-ring";
  // Left of the bubble, on its last line: an overlay over the empty side of the
  // lane, so it never covers the next turn. Hidden, it is not clickable either;
  // the keyboard still reaches it (`focus-within`). Touch has no hover: the
  // long-press sheet of `MessageInteractionShell` carries copy and edit.
  return (
    <div
      data-user-turn-actions=""
      className="pointer-events-none absolute bottom-0.5 right-full z-[1] flex h-8 pe-1 opacity-0 transition-opacity group-hover/message:pointer-events-auto group-hover/message:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 pointer-coarse:hidden"
    >
      {onEdit ? (
        <button type="button" aria-label={t("threadTimeline.streamEdit")} title={t("threadTimeline.streamEdit")} onClick={onEdit} className={button}>
          <StreamIcon name="edit" className="size-4" />
        </button>
      ) : null}
      <button type="button" aria-label={t("threadTimeline.streamCopy")} title={t("threadTimeline.streamCopy")} onClick={() => void copy()} className={button}>
        {copied ? <Check className="size-4" strokeWidth={2} aria-hidden /> : <Copy className="size-4" strokeWidth={2} aria-hidden />}
      </button>
    </div>
  );
}

/**
 * A message written by ANOTHER bot (bot mode, hand-off), role `user` on the
 * server side but `authorBot` set: it renders as the author bot's bubble,
 * never as the operator's.
 */
export const BotInboundMessage = memo(function BotInboundMessage({
  text,
  authorBot,
  findTargetId,
  findActive = false,
}: {
  text: string;
  authorBot: MessageAuthorBot;
  findTargetId: string;
  findActive?: boolean;
}) {
  const { t } = useT();
  const label = authorBot.name ?? authorBot.slug ?? t("threadTimeline.unknownBot");
  return (
    <div
      tabIndex={-1}
      className={`flex max-w-full items-start gap-2 self-start ${findActive ? "rounded-2xl ring-2 ring-primary ring-offset-2" : ""}`}
      aria-label={t("threadTimeline.inboundFrom", { name: label })}
      data-inbound-from={authorBot.id}
      data-thread-find-target={findTargetId}
    >
      <BotFace name={label} seed={authorBot.id} face={authorBot.face} className="size-6 mt-1" />
      <div className="flex flex-col gap-0.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        <div className="rounded-2xl rounded-bl-md bg-muted/70 px-3 py-2 text-sm whitespace-pre-wrap wrap-anywhere">
          {text}
        </div>
      </div>
    </div>
  );
});
