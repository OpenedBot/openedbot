import type { ReactNode } from "react";
import type { BotDto } from "@openedbot/contracts-api";
import { useAgentEditor } from "../../lib/bots/agent-editor";
import { useT } from "../../lib/i18n";
import { useAccountLayout } from "../../lib/shell/account-layout";
import { useMobileDrawer } from "../mobile/mobile-drawer-shell";
import { AccountMenu } from "./account-menu";
import { BotFace } from "../bot-face";
import { BoardHeader } from "./board-chrome";

/** Desktop thread title opens the agent editor; actions show runtime and workflow state. */
export function ConversationHeader({
  bot,
  extra,
  status,
}: {
  bot: BotDto;
  extra?: ReactNode;
  status?: ReactNode;
}) {
  const { t } = useT();
  const accountLayout = useAccountLayout();
  const mobileDrawer = useMobileDrawer();
  const toggleEditor = useAgentEditor((state) => state.toggle);

  return (
    <>
      <BoardHeader
        title={bot.name}
        avatar={<BotFace name={bot.name} seed={bot.id} face={bot.face} className="size-6 shrink-0" />}
        titleAction={{ label: t("boardui.toggleEditor", { name: bot.name }), onClick: toggleEditor }}
        centered
        floating={accountLayout === "c"}
        actions={(
          <>
            {status}
            {extra}
            {accountLayout === "a" && !mobileDrawer ? <AccountMenu variant="avatar" side="bottom" align="end" /> : null}
          </>
        )}
      />
    </>
  );
}
