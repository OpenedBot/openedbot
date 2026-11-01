import { useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, toast } from "@openedbot/browser-ui-kit";
import type { BotDto } from "@openedbot/contracts-api";
import { ApiError, api, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { BUTTON } from "../settings/primitives";

/**
 * What can be done TO a bot (OpenBot `manage.tsx`): pin, hide, archive,
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
    // Rester sur l'URL d'un bot sorti du roster afficherait une erreur au lieu
    // d'un état vide.
    if (routeBotId === bot.id) void navigate({ to: "/", replace: true });
  };
  // Mesuré le 04-09 : un `409 BOT_IN_GROUP` fermait le menu sans un mot, et
  // l'opérateur rejouait le clic. Le message du serveur dit quoi faire.
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
      // Un fil masqué ne reste pas affiché comme s'il appartenait encore au
      // roster courant. Le réafficher ne force aucune navigation.
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
  return { togglePin, toggleArchive, toggleHidden, remove, archived };
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
  onDeleted,
}: {
  bot: BotDto;
  open: boolean;
  onClose: () => void;
  remove: ReturnType<typeof useBotActions>["remove"];
  /** After a confirmed deletion, besides closing this confirmation. */
  onDeleted?: () => void;
}) {
  const { t } = useT();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      role="alertdialog"
      title={t("botContextMenu.deleteTitle", { name: bot.name })}
      description={t("botContextMenu.deleteDescription")}
      closeLabel={t("common.close")}
      swipeToDismiss={false}
      footer={(
        <>
          <button type="button" className={BUTTON.secondary} onClick={onClose} disabled={remove.isPending}>
            {t("botContextMenu.cancel")}
          </button>
          {/* Aucun bouton ne prend le focus à l'ouverture : le clavier entre
              dans le dialogue par Tab, et un Entrée réflexe n'efface rien. */}
          <button
            type="button"
            className={BUTTON.danger}
            onClick={() => remove.mutate(undefined, {
              onSuccess: () => {
                onClose();
                onDeleted?.();
              },
            })}
            disabled={remove.isPending}
          >
            {remove.isPending ? t("botContextMenu.deleting") : t("botContextMenu.delete")}
          </button>
        </>
      )}
    >
      {remove.isError ? (
        <p role="alert" className="text-sm text-destructive-text">
          {t("botContextMenu.deleteError", { message: remove.error.message })}
        </p>
      ) : null}
    </Dialog>
  );
}
