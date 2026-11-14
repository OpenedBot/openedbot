import { RiAddLine, RiMoreFill } from "@remixicon/react";
import { Skeleton } from "@openedbot/browser-ui-kit";
import { SiteHeader } from "./dashboard/site-header";
import { BAR_ICON_BUTTON } from "./boardui/board-chrome";
import { useT } from "../lib/i18n";
import { useAccountLayout } from "../lib/shell/account-layout";

/**
 * The silhouette of a thread while it loads, drawn on the grok thread's
 * geometry (thread-messages.tsx, thread-theme.css) so the messages land in
 * the announced shape without a jump, like the boot silhouette of
 * `index.html` (`#openedbot-boot .thread`):
 *
 * - the reading lane (`data-thread-messages`, 60rem, thread-timeline.css);
 * - the operator's turn is a 36 px bubble on the right (radius 18), the
 *   answer a bubble on the left (radius 18, at most min(80 %, 560 px)), then
 *   its row of four 32 px actions and its duration;
 * - rows are anchored on the composer (`justify-end`): the lane has the
 *   column's height and clips what does not fit above it, so the last turn
 *   sits on the composer as a thread scrolled to its end does.
 *
 * Shapes are neutral: the skeleton does not take the bot's colour the loaded
 * operator bubbles may have.
 */
const TURNS = [
  { ask: "w-44", answer: "w-80", lines: "h-[58px]" },
  { ask: "w-28", answer: "w-24", lines: "h-9" },
  { ask: "w-60", answer: "w-[26rem]", lines: "h-20" },
  { ask: "w-36", answer: "w-56", lines: "h-[58px]" },
] as const;

const PULSE = "motion-reduce:animate-none";

function ThreadRows() {
  return (
    /* pb-[13px]: the loaded thread ends on its 1 px scroll anchor, 12 px
       (`gap-3`) under the last turn (thread-messages.tsx). */
    <div data-thread-messages="" className="flex h-full w-full flex-col justify-end gap-12 overflow-hidden pb-[13px]">
      {TURNS.map((turn, index) => (
        <div key={index} className="flex shrink-0 flex-col">
          <Skeleton className={`${turn.ask} mb-11 h-9 max-w-[min(560px,100%)] self-end rounded-[18px] ${PULSE}`} />
          <div className="flex flex-col items-start">
            <Skeleton className={`${turn.answer} ${turn.lines} max-w-[min(80%,560px)] rounded-[18px] ${PULSE}`} />
            <span className="flex h-8 items-center gap-4 px-2">
              {[0, 1, 2, 3].map((action) => <Skeleton key={action} className={`size-4 rounded ${PULSE}`} />)}
            </span>
            <Skeleton className={`ms-1 mt-1 h-[11px] w-10 ${PULSE}`} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The turn rail (`thread-turn-rail.tsx`): ticks on the thread's left edge,
 * halfway down, drawn at rest as the boot silhouette draws them. Desktop only.
 */
function TurnRailSkeleton() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 hidden w-10 items-center sm:flex">
      <div className="flex flex-col py-1 pl-5">
        {[0, 1, 2].map((tick) => (
          <span key={tick} className="flex h-2 items-center">
            <span className="block h-0.5 w-3.5 rounded-full bg-muted-foreground/40" />
          </span>
        ))}
      </div>
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
      /* The skeleton draws the turn rail: `data-turn-rail` gives it the
         same widened gutter as a thread showing one (thread-timeline.css). */
      data-turn-rail=""
      className="scrollbar-subtle relative min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-4 sm:px-(--openedbot-thread-gutter)"
    >
      <TurnRailSkeleton />
      <ThreadRows />
    </div>
  );
}

/**
 * The `Composer` pill, with its dock's own classes and data attributes so
 * thread-theme.css lays it out the same way: on desktop one 44 px row inside
 * the 1 px line (the 28 px « + », the 28 px field, the model, the 28 px
 * send), the dock 4 px above and 20 px below. Any drift here moves the
 * composer when the thread replaces the skeleton.
 */
function ComposerSkeleton() {
  return (
    <div data-thread-composer="" className="shrink-0 px-4 pt-2 pb-[max(1rem,var(--openedbot-safe-bottom))] sm:p-1">
      <div className="relative w-full">
        <div
          data-composer-shell=""
          className="flex flex-col rounded-3xl border border-transparent bg-background-primary-default shadow-xs"
        >
          <div data-composer-row="">
            {/* thread-theme.css zeroes the field's padding: the line keeps the
                textarea's own inset (4 px on desktop), centred in its 28 px line. */}
            <span data-composer-field="" className="block h-[42px] sm:h-7">
              <Skeleton data-composer="" className={`ms-2 mt-[21px] h-3.5 w-30 sm:ms-1 sm:mt-[7px] ${PULSE}`} />
            </span>
            <span data-composer-attachment="" className="grid place-items-center text-foreground-icon-secondary">
              <RiAddLine />
            </span>
            <Skeleton data-composer-model="" className={`hidden h-[30px] w-[99px] rounded-full sm:block ${PULSE}`} />
            <Skeleton
              data-composer-action="send"
              data-composer-primary-action=""
              /* Not `data-composer-send-action`: on a never-disabled <div> it
                 would paint the live send button's blue. */
              className={`size-10 shrink-0 rounded-full sm:size-7 ${PULSE}`}
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
      <div data-turn-rail="" className="relative min-h-0 flex-1 overflow-hidden px-4 pt-2 pb-4 sm:px-(--openedbot-thread-gutter)">
        <TurnRailSkeleton />
        <ThreadRows />
      </div>
      <ComposerSkeleton />
    </div>
  );
}

/**
 * The conversation header's actions in the top bar (`ConversationHeader`):
 * the model (a 30 px round) and the context pill, data that pulse, then the
 * options menu, drawn as it will be.
 */
export function HeaderActionsSkeleton() {
  return (
    <span aria-hidden className="ms-auto flex shrink-0 items-center gap-1">
      <Skeleton className={`size-[30px] rounded-full ${PULSE}`} />
      <Skeleton className={`h-[26px] w-[71px] rounded-full ${PULSE}`} />
      <span className={BAR_ICON_BUTTON}><RiMoreFill className="size-[18px]" /></span>
    </span>
  );
}

/** The bot's face and name in the breadcrumb, before the roster names them. */
export function HeaderTitleSkeleton() {
  return (
    <span className="flex items-center gap-2">
      <Skeleton className={`size-5 rounded-full ${PULSE}`} />
      <Skeleton className={`h-3.5 w-12 ${PULSE}`} />
    </span>
  );
}

/**
 * First paint of `/bot/:id` or `/g/:id` before the roster delivers the bot or
 * the room: no real chrome yet, so the header and the body are both drawn.
 */
export function ConversationPending() {
  // `ConversationHeader`'s layout: in the rail shell (« c ») the title is a
  // pill floating over the thread and the bar has no model or context
  // actions (they live in the composer), so none are drawn.
  const floating = useAccountLayout() === "c";
  return (
    <>
      <SiteHeader
        /* The title carries a face and a name: it stays pinned to the left. */
        align="start"
        /* On desktop, centred like `ConversationHeader`. */
        centered
        floating={floating}
        title={<HeaderTitleSkeleton />}
        actions={floating ? undefined : <HeaderActionsSkeleton />}
      />
      <ConversationBodySkeleton />
    </>
  );
}
