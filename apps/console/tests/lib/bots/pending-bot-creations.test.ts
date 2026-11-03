import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import {
  linkPendingBotCreation,
  settlePendingBotCreation,
  startPendingBotCreation,
  useJustCreatedBot,
} from "../../../src/lib/bots/pending-bot-creations";

const face = { shape: "blob", color: "green" } as never;
const justCreated = (botId: string) => renderHook(() => useJustCreatedBot(botId)).result.current;

afterEach(cleanup);

describe("a creation linked to its real bot", () => {
  test("the bot's row enters for a moment after the link, settled navigation or not", async () => {
    const pendingId = startPendingBotCreation({ name: "Scout", face });
    expect(justCreated("bot-1")).toBe(false);
    linkPendingBotCreation(pendingId, "bot-1");
    expect(justCreated("bot-1")).toBe(true);
    expect(justCreated("bot-2")).toBe(false);
    // The roster renders on a later tick: the navigation may already be over.
    settlePendingBotCreation(pendingId);
    expect(justCreated("bot-1")).toBe(true);
    await Bun.sleep(1_050);
    expect(justCreated("bot-1")).toBe(false);
  });

  test("linking an unknown or settled creation changes nothing", () => {
    linkPendingBotCreation("creating-gone", "bot-9");
    expect(justCreated("bot-9")).toBe(false);
  });
});
