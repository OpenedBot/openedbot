import { create } from "zustand";
import type { BotDto } from "@openedbot/contracts-api";

/**
 * The two bot surfaces of the app, opened from anywhere (sidebar, overview,
 * context menu, conversation header, agent editor) and mounted once by
 * `BotDialogsHost` in the app frame:
 *
 * - creation: the « Nouveau bot » sheet, blank or prefilled from a bot to
 *   duplicate (`source`);
 * - management: the bot page in rows (`BotManageDialog`), on one bot and
 *   optionally on one of its pages.
 *
 * One opener per surface means one journey: no screen mounts its own copy
 * of these dialogs any more.
 */
export const BOT_MANAGE_PAGES = [
  "persona",
  "model",
  "approvals",
  "skills",
  "mcp",
  "credentials",
  "memory",
  "routines",
  "coordination",
  "activity",
  "runtime",
  "webhooks",
] as const;
export type BotManagePage = (typeof BOT_MANAGE_PAGES)[number];

type BotDialogsState = {
  createOpen: boolean;
  createSource: BotDto | null;
  manageBotId: string | null;
  managePage: BotManagePage | null;
  /**
   * The thread the operator is looking at when the page opens from a
   * conversation: a message branch (`?task=<branchId>`) after an edit or a
   * regeneration, not always `bot.threadId`. `null`: the bot's own thread.
   */
  manageThreadId: string | null;
  /**
   * « Première routine » ticked at creation: the bot's routines open once it
   * exists. Held here, not by the creation surface, because the home form is
   * gone by then (creation opens the bot's waiting screen at once).
   */
  routineBot: BotDto | null;
  openCreate: (source?: BotDto | null) => void;
  closeCreate: () => void;
  openManage: (botId: string, page?: BotManagePage | null, threadId?: string | null) => void;
  closeManage: () => void;
  openRoutines: (bot: BotDto) => void;
  closeRoutines: () => void;
};

export const useBotDialogs = create<BotDialogsState>()((set) => ({
  createOpen: false,
  createSource: null,
  manageBotId: null,
  managePage: null,
  manageThreadId: null,
  routineBot: null,
  openCreate: (source = null) => set({ createOpen: true, createSource: source, manageBotId: null, managePage: null, manageThreadId: null }),
  closeCreate: () => set({ createOpen: false }),
  openManage: (botId, page = null, threadId = null) => set({ manageBotId: botId, managePage: page, manageThreadId: threadId }),
  closeManage: () => set({ manageBotId: null, managePage: null, manageThreadId: null }),
  openRoutines: (bot) => set({ routineBot: bot }),
  closeRoutines: () => set({ routineBot: null }),
}));
