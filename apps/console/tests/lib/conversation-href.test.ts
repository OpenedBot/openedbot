import { describe, expect, test } from "bun:test";
import { conversationHref, conversationPath, isRouteUuid, resolveLegacyConversation } from "../../src/lib/conversation-href";

describe("isRouteUuid", () => {
  test("accepte un UUID v4", () => {
    expect(isRouteUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  test("refuse un slug", () => {
    expect(isRouteUuid("atlas")).toBe(false);
  });
});

describe("conversationHref", () => {
  const bot = { id: "550e8400-e29b-41d4-a716-446655440000" };

  test("la principale va sur /bot sans ?task=", () => {
    expect(conversationHref(bot, { threadId: "t1", isDefault: true })).toEqual({
      to: "/bot/$botId",
      params: { botId: bot.id },
      search: {},
    });
  });

  test("une branche de variante reste sur /bot, marquée par ?task=", () => {
    expect(conversationHref(bot, { threadId: "t2", isDefault: false })).toEqual({
      to: "/bot/$botId",
      params: { botId: bot.id },
      search: { task: "t2" },
    });
  });
});

describe("resolveLegacyConversation", () => {
  const bots = [{ id: "550e8400-e29b-41d4-a716-446655440000", slug: "atlas" }];

  test(" /c/atlas → /bot/:id", () => {
    expect(resolveLegacyConversation("atlas", {}, bots)).toEqual({
      to: "/bot/$botId",
      params: { botId: bots[0]!.id },
      search: {},
    });
  });

  test("/c/atlas?task=t2 → /bot/:id?task=t2", () => {
    expect(resolveLegacyConversation("atlas", { task: "t2" }, bots)).toEqual({
      to: "/bot/$botId",
      params: { botId: bots[0]!.id },
      search: { task: "t2" },
    });
  });

  test("un slug inconnu n'est pas résolu", () => {
    expect(resolveLegacyConversation("atlas", {}, [])).toBeNull();
  });
});

describe("conversationPath", () => {
  test("encode bot et task", () => {
    expect(conversationPath("b1")).toBe("/bot/b1");
    expect(conversationPath("b1", "t2")).toBe("/bot/b1?task=t2");
    expect(conversationPath("b1", undefined, "run:1")).toBe("/bot/b1?focus=run%3A1");
  });
});
