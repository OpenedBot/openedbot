import { useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, toast } from "@openedbot/browser-ui-kit";
import type { BotDto } from "@openedbot/contracts-api";
import { ApiError, api, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { BUTTON } from "../settings/primitives";

/**
 * What can be done TO a bot (the reference app `manage.tsx`): pin, hide, archive,
 * delete. One hook for the sidebar context menu and the bot page, so both
 * entry points run the same mutation, the same guards and the same
 * navigation away from a bot that leaves the roster.
 *
 * « Supprimer » is the two-step deletion of `deleteBot`: the bot goes to the
 * Archives and a durable host cleanup deletes its runtime sessions and its
 * managed profile; the purge (row and history) lives in the Archives.
 */
export function useBotActions(bot: BotDto) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { botId: routeBotId } = useParams({ strict: false }) as { botId?: string };
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.roster });
  const leaveIfOpen = () => {
    // Staying on the URL of a bot that left the roster would show an error instead
    // of an empty state.
    if (routeBotId === bot.id) void navigate({ to: "/", replace: true });
  };
  // Measured on 04-09: a `409 BOT_IN_GROUP` closed the menu without a word, and
  // the operator replayed the click. The server's message says what to do.
  const onError = (error: Error) => toast.error(error instanceof ApiError ? error.message : t("botContextMenu.actionFailed"));

  const togglePin = useMutation({
    mutationFn: () => api.updateBot(bot.id, { pinned: !bot.pinned }),
    onSuccess: invalidate,
    onError,
  });
  const archived = bot.archivedAt !== null;
  const toggleArchive = useMutation({
    mutationFn: () => api.updateBot(bot.id, { archived: !archived }),
    onSuccess: async () => {
      await invalidate();
      if (!archived) leaveIfOpen();
    },
    onError,
  });
  const toggleHidden = useMutation({
    mutationFn: () => bot.hidden ? api.showThread(bot.threadId) : api.hideThread(bot.threadId),
    onSuccess: async () => {
      await invalidate();
      // A hidden thread does not stay displayed as if it still belonged to the
      // current roster. Showing it again forces no navigation.
      if (!bot.hidden) leaveIfOpen();
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteBot(bot.id),
    onSuccess: async () => {
      await invalidate();
      leaveIfOpen();
    },
  });
  // The way out of a `409 BOT_IN_GROUP`: the trash refuses a bot that sits in
  // rooms, the forced purge detaches it from each of them (and deletes a room
  // that would fall under two members) in the transaction that erases it.
  const forcePurge = useMutation({
    mutationFn: () => api.purgeBot(bot.id, { force: true }),
    onSuccess: async (result) => {
      await Promise.all([invalidate(), queryClient.invalidateQueries({ queryKey: queryKeys.groups })]);
      leaveIfOpen();
      toast.success(result.hostCleanup === "queued" ? t("botContextMenu.purgeQueued") : t("botContextMenu.forcePurged", { name: bot.name }));
    },
  });
  return { togglePin, toggleArchive, toggleHidden, remove, forcePurge, archived };
}

/**
 * The deletion confirmation. The application `Dialog`, never
 * `window.confirm`: a native modal is not stylable, blocks rendering, and
 * some webviews do not serve it (the deletion then left unconfirmed).
 */
export function BotDeleteDialog({
  bot,
  open,
  onClose,
  remove,
  forcePurge,
  onDeleted,
}: {
  bot: BotDto;
  open: boolean;
  onClose: () => void;
  remove: ReturnType<typeof useBotActions>["remove"];
  forcePurge: ReturnType<typeof useBotActions>["forcePurge"];
  /** After a confirmed deletion, besides closing this confirmation. */
  onDeleted?: () => void;
}) {
  const { t } = useT();
  // The trash refused a bot that sits in rooms: replaying « Supprimer » would
  // only fail again. The dialog becomes the permanent deletion, which detaches
  // the bot from its rooms, and says so before « Valider ».
  const inGroups = remove.error instanceof ApiError && remove.error.code === "BOT_IN_GROUP";
  const busy = remove.isPending || forcePurge.isPending;
  const close = () => {
    if (busy) return;
    remove.reset();
    forcePurge.reset();
    onClose();
  };
  const done = {
    onSuccess: () => {
      remove.reset();
      forcePurge.reset();
      onClose();
      onDeleted?.();
    },
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      role="alertdialog"
      title={inGroups ? t("botContextMenu.forcePurgeTitle", { name: bot.name }) : t("botContextMenu.deleteTitle", { name: bot.name })}
      description={inGroups ? t("botContextMenu.forcePurgeDescription") : t("botContextMenu.deleteDescription")}
      closeLabel={t("common.close")}
      swipeToDismiss={false}
      footer={(
        <>
          <button type="button" className={BUTTON.secondary} onClick={close} disabled={busy}>
            {t("botContextMenu.cancel")}
          </button>
          {/* No button takes focus on open: the keyboard enters
              the dialog with Tab, and a reflex Enter erases nothing. */}
          {inGroups ? (
            <button
              type="button"
              className={BUTTON.danger}
              data-bot-force-purge=""
              onClick={() => forcePurge.mutate(undefined, done)}
              disabled={busy}
            >
              {forcePurge.isPending ? t("botContextMenu.purging") : t("botContextMenu.forcePurgeConfirm")}
            </button>
          ) : (
            <button
              type="button"
              className={BUTTON.danger}
              onClick={() => remove.mutate(undefined, done)}
              disabled={busy}
            >
              {remove.isPending ? t("botContextMenu.deleting") : t("botContextMenu.delete")}
            </button>
          )}
        </>
      )}
    >
      {/* In rooms, the description already says what « Valider » does: the
          server's « Retirez ce bot de ses salons » would contradict it. */}
      {!inGroups && remove.isError ? (
        <p role="alert" className="text-sm text-destructive-text">
          {t("botContextMenu.deleteError", { message: remove.error.message })}
        </p>
      ) : null}
      {forcePurge.isError ? (
        <p role="alert" className="mt-2 text-sm text-destructive-text">
          {t("botContextMenu.deleteError", { message: forcePurge.error.message })}
        </p>
      ) : null}
    </Dialog>
  );
}
