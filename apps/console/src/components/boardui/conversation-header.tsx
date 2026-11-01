import { useState, type ReactNode } from "react";
import { RiFlashlightLine, RiFlaskLine, RiGroupLine, RiMoreFill, RiSettings3Line } from "@remixicon/react";
import type { BotDto } from "@openedbot/contracts-api";
import { useAgentEditor } from "../../lib/bots/agent-editor";
import { useT } from "../../lib/i18n";
import { useOpenedOnce } from "../../lib/hooks/use-opened-once";
import { useAccountLayout } from "../../lib/shell/account-layout";
import { useMobileDrawer } from "../mobile/mobile-drawer-shell";
import { AccountMenu } from "./account-menu";
import { BotFace } from "../bot-face";
import { GroupDialog } from "../group-dialog";
import { useYoloThreadAction } from "../yolo/yolo-bot-section";
import { BUI_PANEL_ITEM, BuiPopover, BuiPopoverContent, BuiPopoverTrigger, BuiSectionLabel } from "./menu";
import { BAR_ICON_BUTTON, BoardHeader } from "./board-chrome";

/**
 * L'en-tête d'un fil, au bureau, posé dans la barre du haut du cadre :
 * `Salon › bot`, le nom ouvrant ou refermant l'éditeur d'agent ; à droite,
 * ce que le prochain tour va coûter (`context` : la jauge de contexte,
 * `model` : le modèle et l'effort), puis « Copier la conversation » et le
 * menu « Dans cette conversation ». Le retour au Salon est le fil d'Ariane.
 *
 * `extra` reçoit les actions d'openedbot sans équivalent dans la référence (l'état
 * des workflows du fil) : elles se rangent avant les deux icônes, à la
 * même densité.
 *
 * `status` passe avant tout le reste : un état qui empêche le tour (le
 * runtime hors ligne) se lit avant ce que le tour coûterait.
 *
 * `threadId` : le fil affiché, que « Activer YOLO dans cette conversation »
 * vise (owner et admin seulement).
 */
export function ConversationHeader({
  bot,
  threadId,
  extra,
  status,
  context,
  model,
  onOpenSettings,
  onOpenFeatureLab,
}: {
  bot: BotDto;
  threadId?: string | null;
  extra?: ReactNode;
  status?: ReactNode;
  context?: ReactNode;
  model?: ReactNode;
  onOpenSettings: () => void;
  onOpenFeatureLab?: () => void;
}) {
  const { t } = useT();
  const accountLayout = useAccountLayout();
  const mobileDrawer = useMobileDrawer();
  const toggleEditor = useAgentEditor((state) => state.toggle);
  const showEditor = useAgentEditor((state) => state.show);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  // `GroupDialog` observes the roster even closed: mount it on first open only.
  const groupMounted = useOpenedOnce(groupOpen);
  const yolo = useYoloThreadAction({
    botId: bot.id,
    threadId,
    closeMenu: () => setOptionsOpen(false),
    itemClassName: `${BUI_PANEL_ITEM} text-body-medium text-text-primary`,
    icon: <RiFlashlightLine className="size-4 shrink-0" />,
  });

  return (
    <>
      <BoardHeader
        title={bot.name}
        avatar={<BotFace name={bot.name} seed={bot.id} face={bot.face} className="size-5 shrink-0" />}
        titleAction={{ label: t("boardui.toggleEditor", { name: bot.name }), onClick: toggleEditor }}
        centered
        actions={(
          <>
            {status}
            {context}
            {model}
            {extra}
            <BuiPopover open={optionsOpen} onOpenChange={setOptionsOpen}>
              <BuiPopoverTrigger asChild>
                <button type="button" aria-label={t("boardui.conversationOptions")} className={BAR_ICON_BUTTON}>
                  <RiMoreFill className="size-[18px]" />
                </button>
              </BuiPopoverTrigger>
              <BuiPopoverContent align="end" className="w-[256px] gap-1" aria-label={t("boardui.conversationOptions")}>
                <div className="flex w-full flex-col gap-1.5 pt-1">
                  <BuiSectionLabel>{t("boardui.inThisConversation")}</BuiSectionLabel>
                  <div className="flex w-full flex-col gap-1">
                    <button
                      type="button"
                      className={`${BUI_PANEL_ITEM} text-body-medium text-text-primary`}
                      onClick={() => { setOptionsOpen(false); showEditor(null); }}
                    >
                      <BotFace name={bot.name} seed={bot.id} face={bot.face} animated={false} className="size-5 shrink-0" />
                      <span className="truncate">{t("boardui.editNamed", { name: bot.name })}</span>
                    </button>
                    <button
                      type="button"
                      className={`${BUI_PANEL_ITEM} text-body-medium text-text-primary`}
                      onClick={() => { setOptionsOpen(false); setGroupOpen(true); }}
                    >
                      <RiGroupLine className="size-4 shrink-0" />
                      {t("boardui.startGroupChat")}
                    </button>
                    <button
                      type="button"
                      className={`${BUI_PANEL_ITEM} text-body-medium text-text-primary`}
                      onClick={() => { setOptionsOpen(false); onOpenSettings(); }}
                    >
                      <RiSettings3Line className="size-4 shrink-0" />
                      {t("boardui.advancedSettings")}
                    </button>
                    {yolo.item}
                    {onOpenFeatureLab ? (
                      <button
                        type="button"
                        className={`${BUI_PANEL_ITEM} text-body-medium text-text-primary`}
                        onClick={() => { setOptionsOpen(false); onOpenFeatureLab(); }}
                      >
                        <RiFlaskLine className="size-4 shrink-0" />
                        {t("featureLab.open")}
                      </button>
                    ) : null}
                  </div>
                </div>
              </BuiPopoverContent>
            </BuiPopover>
            {accountLayout === "a" && !mobileDrawer ? <AccountMenu variant="avatar" side="bottom" align="end" /> : null}
          </>
        )}
      />
      {groupMounted ? <GroupDialog open={groupOpen} onClose={() => setGroupOpen(false)} initialMemberIds={[bot.id]} /> : null}
      {yolo.dialog}
    </>
  );
}
