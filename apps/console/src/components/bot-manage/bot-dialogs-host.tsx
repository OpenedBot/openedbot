import { Suspense, useEffect, useRef } from "react";
import { lazyRouteComponent, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { BotDto } from "@openedbot/contracts-api";
import { api, queryKeys } from "../../lib/api";
import { useBotDialogs } from "../../lib/bots/bot-dialogs";
import { useOpenedOnce } from "../../lib/hooks/use-opened-once";

// Each dialog is its own chunk, fetched on its first opening: the bot page
// alone carries the persona editor, the capabilities, the model picker and
// their markdown, none of which the frame needs to draw.
const CreateBotSheet = lazyRouteComponent(() => import("../bot-create/create-bot-sheet"), "CreateBotSheet");
const BotRoutinesDialog = lazyRouteComponent(() => import("../bot-routines-dialog"), "BotRoutinesDialog");
const BotManageDialog = lazyRouteComponent(() => import("./bot-manage-dialog"), "BotManageDialog");

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
  const routineBot = useBotDialogs((state) => state.routineBot);
  const closeRoutines = useBotDialogs((state) => state.closeRoutines);
  const navigate = useNavigate();
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
      {/* One boundary each: a dialog loading its chunk never hides another one already open. */}
      {createMounted ? <Suspense fallback={null}><CreateBotSheet open={createOpen} source={createSource} onClose={closeCreate} /></Suspense> : null}
      {routineBot ? (
        <Suspense fallback={null}>
          <BotRoutinesDialog
            bot={routineBot}
            open
            onClose={() => {
              closeRoutines();
              void navigate({ to: "/bot/$botId", params: { botId: routineBot.id } });
            }}
          />
        </Suspense>
      ) : null}
      {shownBot ? (
        <Suspense fallback={null}>
          <BotManageDialog
            bot={shownBot}
            open={bot !== null}
            initialPage={managePage}
            threadId={manageThreadId}
            onClose={closeManage}
          />
        </Suspense>
      ) : null}
    </>
  );
}
