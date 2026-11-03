import { RiMoreFill, RiShare2Line } from "@remixicon/react";
import { Skeleton } from "@openedbot/browser-ui-kit";
import { SiteHeader } from "./dashboard/site-header";
import { BAR_ICON_BUTTON } from "./boardui/board-chrome";
import { useT } from "../lib/i18n";

/**
 * The silhouette of a thread while it loads, drawn on the real thread's
 * geometry so the messages land in the announced shape without a jump:
 *
 * - the reading column (`data-thread-column`, 60rem)
 *   centres the rows through `thread-timeline.css`, exactly like the thread;
 * - an operator message is a bubble on the right (`data-user-bubble`: 42 px
 *   tall, rounded 16 px), an answer is text on the left with its duration
 *   underneath, not a bubble with a face;
 * - rows are anchored on the composer (`justify-end`, gap 12 px).
 *
 * Shapes are neutral: the skeleton does not take the accent the loaded
 * bubbles may have.
 */
const TURNS = [
  { ask: "w-44", answer: "w-80" },
  { ask: "w-28", answer: "w-24" },
  { ask: "w-60", answer: "w-[26rem]" },
  { ask: "w-36", answer: "w-56" },
  { ask: "w-24", answer: "w-40" },
] as const;

function ThreadRows() {
  return (
    <div data-thread-messages="" className="flex min-h-full w-full flex-col justify-end gap-3">
      {TURNS.map((turn, index) => (
        <div key={index} className="flex flex-col gap-3">
          <Skeleton className={`${turn.ask} h-[42px] max-w-[80%] self-end rounded-2xl motion-reduce:animate-none`} />
          <div className="flex flex-col gap-2 pt-1">
            <Skeleton className={`${turn.answer} h-4 max-w-full motion-reduce:animate-none`} />
            <Skeleton className="h-3 w-10 motion-reduce:animate-none" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** The thread alone: the real `Composer` stays rendered (disabled) under it. */
export function ThreadSkeleton() {
  const { t } = useT();
  return (
    <div
      role="status"
      aria-label={t("conversation.loading")}
      className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6"
    >
      <ThreadRows />
    </div>
  );
}

/** The composer's frame: text line, then `+`, mode chip, microphone and send. */
function ComposerSkeleton() {
  return (
    <div data-thread-composer="" className="shrink-0 px-4 pt-2 pb-[max(1rem,var(--ohb-safe-bottom))] sm:px-6">
      <div className="relative w-full">
        <div
          data-composer-shell=""
          className="flex flex-col gap-1.5 rounded-3xl border border-transparent bg-background-primary-default px-2 py-1.5 shadow-xs"
        >
          <Skeleton data-composer="" className="my-1.5 h-7 w-full rounded-xl motion-reduce:animate-none" />
          <div data-composer-row="" className="flex items-center gap-2">
            <Skeleton data-composer-attachment="" className="size-11 shrink-0 rounded-full motion-reduce:animate-none sm:size-8" />
            <Skeleton className="h-6 w-20 shrink-0 rounded-full motion-reduce:animate-none" />
            <span className="min-w-0 flex-1" />
            <Skeleton data-composer-voice="" className="size-11 shrink-0 rounded-full motion-reduce:animate-none sm:size-8" />
            <Skeleton
              data-composer-action="send"
              data-composer-primary-action=""
              className="size-11 shrink-0 rounded-full motion-reduce:animate-none sm:size-8"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A whole conversation body before its screen exists (frame guards, or the
 * roster not yet there): reading column, thread rows and composer.
 */
export function ConversationBodySkeleton() {
  return (
    <div data-thread-column="" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-hidden px-4 py-4 sm:px-6">
        <ThreadRows />
      </div>
      <ComposerSkeleton />
    </div>
  );
}

/**
 * The conversation header's actions in the top bar: context gauge and model
 * pill (data, they pulse), then copy and options (decor, drawn as they will be).
 */
export function HeaderActionsSkeleton() {
  return (
    <span aria-hidden className="flex shrink-0 items-center gap-1">
      <Skeleton className="me-1 h-4 w-10 motion-reduce:animate-none" />
      <Skeleton className="h-[30px] w-36 rounded-full motion-reduce:animate-none" />
      <span className={BAR_ICON_BUTTON}><RiShare2Line className="size-[18px]" /></span>
      <span className={BAR_ICON_BUTTON}><RiMoreFill className="size-[18px]" /></span>
    </span>
  );
}

/** The bot's face and name in the breadcrumb, before the roster names them. */
export function HeaderTitleSkeleton() {
  return (
    <span className="flex items-center gap-2">
      <Skeleton className="size-5 rounded-full motion-reduce:animate-none" />
      <Skeleton className="h-3.5 w-40 motion-reduce:animate-none" />
    </span>
  );
}

/**
 * First paint of `/bot/:id` or `/g/:id` before the roster delivers the bot or
 * the room: no real chrome yet, so the header and the body are both drawn.
 */
export function ConversationPending() {
  return (
    <>
      <SiteHeader
        /* Le titre porte un visage et un nom : il reste calé à gauche. */
        align="start"
        title={<HeaderTitleSkeleton />}
        actions={<HeaderActionsSkeleton />}
      />
      <ConversationBodySkeleton />
    </>
  );
}
