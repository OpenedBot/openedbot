import { describe, expect, test } from "bun:test";
import { pushEventBody, pushEventUrl, webPushPayload } from "../src/domain/push-payload";

describe("webPushPayload", () => {
  test("a client notification carries its tenant even when another workspace is open", () => {
    expect(pushEventUrl("run.completed", "bot-9", "client-b")).toBe("/o/client-b/bot/bot-9");
    expect(pushEventUrl("approval.requested", "bot-9", "client-b")).toBe("/o/client-b/decisions");
  });
  test("une approbation pointe /decisions et ne porte pas le nom du fil", () => {
    const payload = webPushPayload({
      botName: "SEO Geo",
      eventType: "approval.requested",
      botId: "bot-1",
      locale: "fr",
    });
    expect(payload.title).toBe("SEO Geo");
    expect(payload.url).toBe("/decisions");
    expect(payload.body).toBe("Approbation demandée");
    expect(JSON.stringify(payload)).not.toMatch(/prompt|message|error detail/i);
  });

  test("une issue de routine pointe /bot/<id>", () => {
    expect(pushEventUrl("run.completed", "bot-9")).toBe("/bot/bot-9");
    expect(pushEventUrl("run.error", "bot-9")).toBe("/bot/bot-9");
    expect(pushEventUrl("run.completed", null)).toBe("/");
  });

  test("le corps suit la locale, jamais un texte de message", () => {
    expect(pushEventBody("run.completed", "en")).toBe("Workflow completed");
    expect(pushEventBody("run.error", "fr")).toBe("Échec du workflow");
  });

  test("un nom de bot vide retombe sur openedbot", () => {
    expect(webPushPayload({
      botName: "  ",
      eventType: "run.completed",
      botId: "bot-1",
      locale: "en",
    }).title).toBe("openedbot");
  });
});
