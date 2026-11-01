import { useState, type ReactNode } from "react";
import { useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  RiArchiveLine,
  RiDeleteBinLine,
  RiEditLine,
  RiEyeLine,
  RiEyeOffLine,
  RiFileCopy2Line,
  RiFolderTransferLine,
  RiGroupLine,
  RiHashtag,
  RiMailUnreadLine,
  RiMoreFill,
  RiPushpinLine,
  RiSettings3Line,
  RiTimeLine,
} from "@remixicon/react";
import { toast } from "@openedbot/browser-ui-kit";
import type { BotDto } from "@openedbot/contracts-api";
import { api, queryKeys } from "../lib/api";
import { BotGroupsDialog } from "./bot-groups-dialog";
import { MoveToSectionDialog } from "./move-to-section-dialog";
import { useT } from "../lib/i18n";
import { useAgentEditor } from "../lib/agent-editor";
import { useBotDialogs } from "../lib/bot-dialogs";
import { useOpenedOnce } from "../lib/use-opened-once";
import { BotFace } from "./bot-face";
import { BotDeleteDialog, useBotActions } from "./bot-manage/bot-actions";
import {
  BuiContextMenu,
  BuiContextMenuContent,
  BuiContextMenuItem,
  BuiContextMenuTrigger,
  BuiContextSub,
  BuiContextSubContent,
  BuiContextSubTrigger,
} from "./boardui/menu";

/**
 * Menu contextuel d'un bot, au clic droit : l'idiome d'OpenMausBot et de
 * Grok Bot. Il ouvre les deux surfaces du bot (l'éditeur d'agent pour son
 * profil, sa page pour tout le reste) et porte les mêmes gestes que la page
 * (`useBotActions`) : épingler, masquer, dupliquer, archiver, supprimer.
 *
 * « Supprimer » met à la corbeille chez openedbot et programme l'effacement des
 * sessions et du profil géré sur l'hôte Hermes. La suppression définitive
 * vit dans Réglages → Archives.
 */
export function BotContextMenu({
  bot,
  children,
  onRename,
}: {
  bot: BotDto;
  children: ReactNode;
  /** La barre rend la ligne éditable sur place ; ailleurs, l'éditeur d'agent. */
  onRename?: () => void;
}) {
  const { t } = useT();
  const showEditor = useAgentEditor((state) => state.show);
  const openManage = useBotDialogs((state) => state.openManage);
  const openCreate = useBotDialogs((state) => state.openCreate);
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const canWrite = me.data?.kind === "session" && me.data.session.canWrite === true;
  const { botId: routeBotId } = useParams({ strict: false }) as { botId?: string };
  const [confirming, setConfirming] = useState(false);
  const [managingGroups, setManagingGroups] = useState(false);
  const [movingToSection, setMovingToSection] = useState(false);
  // Each sidebar row carries this menu: its dialogs mount on first open only.
  const groupsMounted = useOpenedOnce(managingGroups);
  const sectionMounted = useOpenedOnce(movingToSection);
  const deleteMounted = useOpenedOnce(confirming);
  const actions = useBotActions(bot);

  const markUnread = useMutation({
    mutationFn: () => api.markThreadUnread(bot.threadId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.roster }),
  });
  const editProfile = () => showEditor(bot.id === routeBotId ? null : bot.id);

  const copyConversationId = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(bot.threadId);
      toast.success(t("botContextMenu.copyConversationIdSuccess"));
    } catch {
      toast.error(t("botContextMenu.copyConversationIdError"));
    }
  };

  return (
    <>
      <BuiContextMenu>
        <BuiContextMenuTrigger asChild>{children}</BuiContextMenuTrigger>
        <BuiContextMenuContent aria-label={t("boardui.chatActions")}>
          <BuiContextMenuItem icon={RiPushpinLine} onSelect={() => actions.togglePin.mutate()}>
            {bot.pinned ? t("boardui.unpinChat") : t("boardui.pinChat")}
          </BuiContextMenuItem>
          <BuiContextMenuItem icon={RiEditLine} onSelect={() => (onRename ? onRename() : editProfile())}>
            {t("boardui.renameChat")}
          </BuiContextMenuItem>
          <BuiContextMenuItem
            leading={<BotFace name={bot.name} seed={bot.id} face={bot.face} animated={false} className="size-5" />}
            onSelect={editProfile}
          >
            {t("boardui.editBot")}
          </BuiContextMenuItem>
          <BuiContextMenuItem icon={RiSettings3Line} onSelect={() => openManage(bot.id)}>
            {t("botManage.open")}
          </BuiContextMenuItem>
          <BuiContextMenuItem icon={RiHashtag} onSelect={() => { void copyConversationId(); }}>
            {t("boardui.copyConversationId")}
          </BuiContextMenuItem>
          <BuiContextSub>
            <BuiContextSubTrigger icon={RiMoreFill}>{t("boardui.more")}</BuiContextSubTrigger>
            <BuiContextSubContent>
              <BuiContextMenuItem icon={RiGroupLine} onSelect={() => setManagingGroups(true)}>
                {t("groups.manageForBot")}
              </BuiContextMenuItem>
              {canWrite ? (
                <BuiContextMenuItem icon={RiFolderTransferLine} onSelect={() => setMovingToSection(true)}>
                  {t("appSidebar.moveToSection")}
                </BuiContextMenuItem>
              ) : null}
              {canWrite ? (
                <BuiContextMenuItem icon={RiTimeLine} onSelect={() => openManage(bot.id, "routines")}>
                  {t("botContextMenu.routines")}
                </BuiContextMenuItem>
              ) : null}
              <BuiContextMenuItem icon={RiFileCopy2Line} onSelect={() => openCreate(bot)}>
                {t("botManage.duplicate")}
              </BuiContextMenuItem>
              <BuiContextMenuItem icon={RiMailUnreadLine} onSelect={() => markUnread.mutate()}>
                {t("botContextMenu.markUnread")}
              </BuiContextMenuItem>
              <BuiContextMenuItem icon={bot.hidden ? RiEyeLine : RiEyeOffLine} onSelect={() => actions.toggleHidden.mutate()}>
                {bot.hidden ? t("botContextMenu.show") : t("botContextMenu.hide")}
              </BuiContextMenuItem>
              <BuiContextMenuItem icon={RiArchiveLine} onSelect={() => actions.toggleArchive.mutate()}>
                {actions.archived ? t("botContextMenu.unarchive") : t("botContextMenu.archive")}
              </BuiContextMenuItem>
            </BuiContextSubContent>
          </BuiContextSub>
          <BuiContextMenuItem icon={RiDeleteBinLine} destructive onSelect={() => setConfirming(true)}>
            {t("botContextMenu.deleteBot")}
          </BuiContextMenuItem>
        </BuiContextMenuContent>
      </BuiContextMenu>

      {deleteMounted ? (
        <BotDeleteDialog bot={bot} open={confirming} onClose={() => setConfirming(false)} remove={actions.remove} />
      ) : null}
      {groupsMounted ? <BotGroupsDialog bot={bot} open={managingGroups} onClose={() => setManagingGroups(false)} /> : null}
      {sectionMounted ? <MoveToSectionDialog row={{ kind: "bot", bot }} open={movingToSection} onClose={() => setMovingToSection(false)} /> : null}
    </>
  );
}
