import { RiMoreFill } from "@remixicon/react";
import { IconShieldLock } from "@tabler/icons-react";
import { Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import type { BotDto, RosterDto } from "@openedbot/contracts-api";
import { Skeleton, useIsMobile } from "@openedbot/browser-ui-kit";
import { BotFace } from "./bot-face";
import { ConversationHeader } from "./boardui/conversation-header";
import { ModelHeaderGlyph } from "./composer-model-header";
import { StreamIcon } from "./stream/stream-icons";
import { queryKeys } from "../lib/api";
import { readBootBot } from "../lib/session/boot-bots";
import { readCloudSession } from "../lib/session/cloud-session";
import { SHOW_FEATURE_LAB } from "../lib/thread/dev-approval-probe";
import { BUTTON } from "./settings/primitives";
import { SiteHeader } from "./dashboard/site-header";
import { BAR_ICON_BUTTON } from "./boardui/board-chrome";
import { useT } from "../lib/i18n";
import { useAccountLayout } from "../lib/shell/account-layout";

const PULSE = "motion-reduce:animate-none";

/**
 * The thread while it loads: a spinner in the middle of the reading area, no
 * grey rows. It fades in after a short delay (`openedbot-thread-loading`,
 * thread-timeline.css): a thread read back from the cache replaces it before
 * it ever shows. The `index.html` silhouette draws the same spinner.
 */
export function ThreadLoading() {
  const { t } = useT();
  return (
    <div role="status" aria-label={t("conversation.loading")} className="flex min-h-0 flex-1 items-center justify-center">
      <span aria-hidden className="openedbot-thread-loading flex">
        <Loader2 className="size-5 animate-spin text-foreground-icon-secondary motion-reduce:animate-none" />
      </span>
    </div>
  );
}

/** The bot a conversation stand-in draws: the roster in cache first, else the last visit's (`lib/session/boot-bots.ts`). */
function useStandInBot(botId: string | undefined): { bot: BotDto | null; name: string | null; provider: string | null } {
  const queryClient = useQueryClient();
  const bot = botId ? queryClient.getQueryData<RosterDto>(queryKeys.roster)?.bots.find((entry) => entry.id === botId) ?? null : null;
  const remembered = readBootBot(readCloudSession()?.userId, botId);
  return { bot, name: bot?.name ?? remembered?.name ?? null, provider: remembered?.provider ?? null };
}

/**
 * The `Composer` as it is at rest, drawn before the conversation screen has
 * loaded: same markup, data attributes and classes as `composer.tsx` (its
 * idle row: « + », the field, the model button, send greyed by the empty
 * field), so the real one replaces it without a visible change. Inert: the
 * real composer takes the input a moment later. Keep in step with
 * `composer.tsx` and the `.composer` of `index.html`.
 */
function ComposerPlaceholder({ name, provider }: { name: string | null; provider: string | null }) {
  const { t } = useT();
  return (
    <div aria-hidden inert data-thread-composer="" className="shrink-0 px-4 pt-2 pb-[max(1rem,var(--openedbot-safe-bottom))] sm:p-1">
      <div className="relative w-full">
        <div
          data-composer-shell=""
          className="relative flex flex-col rounded-[var(--radius-2-5xl)] border border-composer-edge bg-background-primary-default p-2 shadow-xs sm:p-[7px]"
        >
          <div data-composer-row="" className="flex items-end gap-2 sm:items-center sm:gap-1.5">
            <span
              data-composer-attachment=""
              className="mb-0.5 flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground sm:order-1 sm:mb-0 sm:size-7 sm:bg-composer-panel-add-background sm:p-1 sm:text-foreground-icon-primary"
            >
              <StreamIcon name="plus" className="size-5" />
            </span>
            <div data-composer-field="" className="relative my-1.5 min-w-0 flex-1 sm:order-1 sm:my-0 sm:px-2">
              <textarea
                data-composer=""
                readOnly
                tabIndex={-1}
                rows={1}
                placeholder={name ? t("composer.messagePlaceholder", { botName: name }) : t("mobileComposer.placeholder")}
                className="no-scrollbar relative block max-h-[200px] min-h-5 w-full resize-none overflow-hidden bg-transparent p-0 text-body-regular text-text-primary outline-none placeholder:text-text-tertiary [&:placeholder-shown]:truncate"
              />
            </div>
            <div data-composer-model="" className="contents sm:order-4 sm:me-2 sm:ml-auto sm:block">
              <span className="hidden size-[30px] shrink-0 items-center justify-center rounded-full border border-border-button-default bg-background-primary-default sm:flex">
                <ModelHeaderGlyph provider={provider} warn={false} fallback={false} />
              </span>
            </div>
            {/* A disabled button, as the real one with an empty field: the
                thread theme paints its faded blue on `:disabled`. */}
            <button
              type="button"
              disabled
              tabIndex={-1}
              data-composer-action="send"
              data-composer-primary-action=""
              data-composer-send-action=""
              className="bg-button-primary mb-0.5 flex size-11 shrink-0 items-center justify-center rounded-full p-2 text-white disabled:opacity-30 sm:order-6 sm:mb-0 sm:size-7 sm:p-1"
            >
              <StreamIcon name="arrowUp" className="size-4 sm:size-5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A whole conversation body before its screen exists (frame guards, the
 * screen's code still loading, or the roster not yet there): the reading
 * column with its spinner, and the composer at rest.
 */
export function ConversationBodyPending({ botId }: { botId?: string }) {
  const { name, provider } = useStandInBot(botId);
  return (
    <div data-thread-column="" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ThreadLoading />
      <ComposerPlaceholder name={name} provider={provider} />
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

/**
 * The bot's face and name in the breadcrumb, before the screen draws them:
 * the roster in cache gives both, the last visit gives the name (the face
 * stays a still neutral disc); only an unknown bot pulses.
 */
export function HeaderTitleSkeleton({ botId }: { botId?: string }) {
  const { bot, name } = useStandInBot(botId);
  // `BoardHeader`'s title: 14 px in the floating pill of the rail shell, 13 px
  // in the bar; the face is 24 px in both (`ConversationHeader`).
  const text = useAccountLayout() === "c" ? "text-body-medium" : "text-body-2-medium";
  if (bot || name) {
    return (
      <span className="flex min-w-0 items-center gap-2">
        {bot
          ? <BotFace name={bot.name} seed={bot.id} face={bot.face} className="size-6 shrink-0" />
          : <span className="size-6 shrink-0 rounded-full bg-background-tertiary-default" />}
        <span className={`truncate font-semibold text-text-primary ${text}`}>{bot?.name ?? name}</span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <Skeleton className={`size-5 rounded-full ${PULSE}`} />
      <Skeleton className={`h-3.5 w-12 ${PULSE}`} />
    </span>
  );
}

/**
 * The conversation header's own buttons as they will be (« Fichiers », and
 * the scenario lab on a dev server), inert until the screen draws the real
 * ones. Keep in step with `conversation.tsx` (`extra`) and the `.hacts` of
 * `index.html`.
 */
export function HeaderExtrasAtRest({ withFiles }: { withFiles: boolean }) {
  const { t } = useT();
  return (
    <span aria-hidden inert className="contents">
      {withFiles ? <span className={BUTTON.small}>{t("mvp.files")}</span> : null}
      {SHOW_FEATURE_LAB ? (
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-foreground">
          <IconShieldLock className="size-3.5" />
        </span>
      ) : null}
    </span>
  );
}

/**
 * First paint of `/bot/:id` or `/g/:id` before the conversation screen draws
 * itself (its code still loading, or the roster not yet read). A bot the
 * roster in cache knows gets its real header; otherwise the header is drawn
 * from the last visit, and the body is the spinner and the composer at rest.
 */
export function ConversationPending({ botId }: { botId?: string }) {
  // `ConversationHeader`'s layout: in the rail shell (« c ») the title is a
  // pill floating over the thread and the bar has no model or context
  // actions (they live in the composer), so none are drawn.
  const floating = useAccountLayout() === "c";
  const { bot } = useStandInBot(botId);
  // The phone draws its own header (`MobileFrame`), not `ConversationHeader`.
  const isMobile = useIsMobile();
  return (
    <>
      {bot && !isMobile ? <ConversationHeader bot={bot} extra={<HeaderExtrasAtRest withFiles={Boolean(bot.threadId)} />} /> : (
        <SiteHeader
          /* The title carries a face and a name: it stays pinned to the left. */
          align="start"
          /* On desktop, centred like `ConversationHeader`. */
          centered
          floating={floating}
          title={<HeaderTitleSkeleton botId={botId} />}
          actions={floating ? undefined : <HeaderActionsSkeleton />}
        />
      )}
      <ConversationBodyPending botId={botId} />
    </>
  );
}
