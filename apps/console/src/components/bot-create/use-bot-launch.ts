import { useNavigate, useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { BotDto, RosterDto } from "@openedbot/contracts-api";
import { toast } from "@openedbot/browser-ui-kit";
import { ApiError, api, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import {
  failPendingBotCreation,
  linkPendingBotCreation,
  resumePendingBotCreation,
  settlePendingBotCreation,
  startPendingBotCreation,
} from "../../lib/bots/pending-bot-creations";
import { ensureCreationRoutine } from "../../lib/bots/creation-routine";
import { sendBotCreation, type BotCreationRequest } from "./creation-request";

/**
 * The start of a creation, shared by the « Nouveau bot » sheet and by
 * the home `/`: the bot's waiting screen opens at once
 * (`/bot/<provisional id>`), the request leaves behind it and keeps its
 * `clientRequestId`, which « Réessayer » replays with no risk of a duplicate.
 */
export function useBotCreationLaunch() {
  const { t } = useT();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();

  const errorMessage = (error: unknown) => error instanceof ApiError ? error.message : t("newBotDialog.createFailed");

  /**
   * The roster knows the bot BEFORE any screen looks for it: the answered bot
   * goes into the cached roster, then the roster is read again. Opening
   * `/bot/<id>` first would show « ce bot n'existe plus » while a slow
   * refetch is still under way (the query is not pending, it has data).
   * With the bot in the cache, the refetch is not waited for: waiting left
   * its new sidebar row unselected for a beat.
   */
  const rememberCreated = (bot: BotDto): Promise<void> => {
    const cached = queryClient.setQueryData<RosterDto>(queryKeys.roster, (current) => current && !current.bots.some((entry) => entry.id === bot.id)
      ? { ...current, bots: [...current.bots, bot] }
      : current);
    const refetched = queryClient.invalidateQueries({ queryKey: queryKeys.roster });
    return cached?.bots.some((entry) => entry.id === bot.id) ? Promise.resolve() : refetched;
  };

  /**
   * The routine a suggestion brought, once the bot exists. A failure leaves
   * the bot as created and says so, with where to add the routine by hand:
   * failing the whole creation would offer « Réessayer » on a bot that
   * already exists.
   */
  const programRoutine = (bot: BotDto, routine: NonNullable<BotCreationRequest["routine"]>) => {
    ensureCreationRoutine(api, bot.id, routine).then(
      () => queryClient.invalidateQueries({ queryKey: queryKeys.routines(bot.id) }),
      (error: unknown) => {
        toast.error(t("homeNewBot.routineFailed", {
          bot: bot.name,
          name: routine.name,
          message: error instanceof Error ? error.message : String(error),
        }));
      },
    );
  };

  /** The waiting screen owns the attempt: it can replay it, with the same id. */
  const send = (request: BotCreationRequest, pendingId: string, onCreated?: (bot: BotDto) => void) => {
    sendBotCreation(request).then(async (bot) => {
      linkPendingBotCreation(pendingId, bot.id);
      await rememberCreated(bot);
      // Still on the creation screen: it becomes the bot's conversation.
      // Left elsewhere in the meantime: the bot waits in the list.
      if (router.state.location.pathname.endsWith(`/bot/${pendingId}`)) {
        await navigate({ to: "/bot/$botId", params: { botId: bot.id }, replace: true });
      }
      settlePendingBotCreation(pendingId);
      if (request.routine) programRoutine(bot, request.routine);
      onCreated?.(bot);
    }, (error: unknown) => {
      failPendingBotCreation(pendingId, errorMessage(error), () => {
        resumePendingBotCreation(pendingId);
        send(request, pendingId, onCreated);
      });
    });
  };

  /** Opens the bot's waiting screen and sends the frozen request behind it. */
  return (request: BotCreationRequest, onCreated?: (bot: BotDto) => void) => {
    const pendingId = startPendingBotCreation({ name: request.name, face: request.face });
    send(request, pendingId, onCreated);
    void navigate({ to: "/bot/$botId", params: { botId: pendingId } });
  };
}
