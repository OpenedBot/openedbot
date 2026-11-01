import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { BotDto } from "@openedbot/contracts-api";
import { api, queryKeys } from "../../lib/api";
import { useBotDialogs } from "../../lib/bots/bot-dialogs";
import { useOpenedOnce } from "../../lib/hooks/use-opened-once";
import { CreateBotSheet } from "../bot-create/create-bot-sheet";
import { BotManageDialog } from "./bot-manage-dialog";

/**
 * The one mount of the creation sheet and of the bot page (`lib/bots/bot-dialogs.ts`),
 * placed by the app frames next to the agent editor. Both dialogs mount on
 * their first opening only, so a cold frame pays nothing for them.
 */
export function BotDialogsHost() {
  const createOpen = useBotDialogs((state) => state.createOpen);
  const createSource = useBotDialogs((state) => state.createSource);
  const closeCreate = useBotDialogs((state) => state.closeCreate);
  const manageBotId = useBotDialogs((state) => state.manageBotId);
  const managePage = useBotDialogs((state) => state.managePage);
  const manageThreadId = useBotDialogs((state) => state.manageThreadId);
  const closeManage = useBotDialogs((state) => state.closeManage);
  const createMounted = useOpenedOnce(createOpen);
  const roster = useQuery({ queryKey: queryKeys.roster, queryFn: api.roster, enabled: manageBotId !== null });
  // A bot deleted (or hidden) from its own page leaves the roster: the page closes.
  const bot = manageBotId
    ? roster.data?.bots.find((candidate) => candidate.id === manageBotId && !candidate.deletedAt) ?? null
    : null;
  // Kept after closing so the dialog plays its exit instead of vanishing.
  const lastBot = useRef<BotDto | null>(null);
  if (bot) lastBot.current = bot;
  const shownBot = bot ?? lastBot.current;
  const gone = manageBotId !== null && roster.isSuccess && bot === null;
  useEffect(() => {
    if (gone) closeManage();
  }, [gone, closeManage]);

  return (
    <>
      {createMounted ? <CreateBotSheet open={createOpen} source={createSource} onClose={closeCreate} /> : null}
      {shownBot ? (
        <BotManageDialog
          bot={shownBot}
          open={bot !== null}
          initialPage={managePage}
          threadId={manageThreadId}
          onClose={closeManage}
        />
      ) : null}
    </>
  );
}
