import { describe, expect, test } from "bun:test";
import {
  alertRetryDelaySeconds,
  classifyDiscordResponse,
  discordAlertMessage,
  discordRetryAfterSeconds,
  discordTestMessage,
  discordWebhookHint,
  escapeDiscordMarkdown,
  formatOutage,
  parseDiscordWebhookUrl,
  readAlertChannelLabel,
} from "../src/domain/alert-channels";

const ID = "1459685375038591192";
const TOKEN = "A".repeat(34) + "_b-" + "9".repeat(31);

describe("parseDiscordWebhookUrl", () => {
  test("accepts a webhook URL and canonicalises its host", () => {
    for (const host of ["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com", "DISCORD.com"]) {
      expect(parseDiscordWebhookUrl(`  https://${host}/api/webhooks/${ID}/${TOKEN}  `)).toEqual({
        url: `https://discord.com/api/webhooks/${ID}/${TOKEN}`,
        webhookId: ID,
      });
    }
    expect(parseDiscordWebhookUrl(`https://discord.com/api/v10/webhooks/${ID}/${TOKEN}/`)).toEqual({
      url: `https://discord.com/api/webhooks/${ID}/${TOKEN}`,
      webhookId: ID,
    });
  });

  test("refuses anything the API should not call (SSRF)", () => {
    expect(parseDiscordWebhookUrl(`http://discord.com/api/webhooks/${ID}/${TOKEN}`)).toBe("not_discord");
    expect(parseDiscordWebhookUrl(`https://discord.com.evil.test/api/webhooks/${ID}/${TOKEN}`)).toBe("not_discord");
    expect(parseDiscordWebhookUrl(`https://evil.test/api/webhooks/${ID}/${TOKEN}`)).toBe("not_discord");
    expect(parseDiscordWebhookUrl(`https://user:pass@discord.com/api/webhooks/${ID}/${TOKEN}`)).toBe("not_discord");
    expect(parseDiscordWebhookUrl(`https://discord.com:8443/api/webhooks/${ID}/${TOKEN}`)).toBe("not_discord");
    expect(parseDiscordWebhookUrl("https://127.0.0.1/api/webhooks/1/2")).toBe("not_discord");
    expect(parseDiscordWebhookUrl(`https://discord.com/api/webhooks/${ID}/${TOKEN}?thread_id=1`)).toBe("not_a_webhook");
    expect(parseDiscordWebhookUrl(`https://discord.com/api/webhooks/${ID}/${TOKEN}#x`)).toBe("not_a_webhook");
    expect(parseDiscordWebhookUrl(`https://discord.com/api/webhooks/${ID}/${TOKEN}/slack`)).toBe("not_a_webhook");
    expect(parseDiscordWebhookUrl(`https://discord.com/api/webhooks/${ID}/short`)).toBe("not_a_webhook");
    expect(parseDiscordWebhookUrl("https://discord.com/channels/1/2")).toBe("not_a_webhook");
    expect(parseDiscordWebhookUrl("pas une url")).toBe("invalid_url");
    expect(parseDiscordWebhookUrl("")).toBe("invalid_url");
    expect(parseDiscordWebhookUrl(42)).toBe("invalid_url");
    expect(parseDiscordWebhookUrl(`https://discord.com/api/webhooks/${ID}/${"x".repeat(400)}`)).toBe("invalid_url");
  });

  test("the hint shows the public id, never the token", () => {
    const hint = discordWebhookHint(ID);
    expect(hint).toContain(ID);
    expect(hint).not.toContain(TOKEN.slice(0, 8));
  });
});

describe("readAlertChannelLabel", () => {
  test("trims, collapses spaces and bounds the length", () => {
    expect(readAlertChannelLabel("  #ops   alertes ")).toBe("#ops alertes");
    expect(readAlertChannelLabel("")).toBeNull();
    expect(readAlertChannelLabel("   ")).toBeNull();
    expect(readAlertChannelLabel("x".repeat(81))).toBeNull();
    expect(readAlertChannelLabel(null)).toBeNull();
  });
});

describe("discordAlertMessage", () => {
  const down = {
    runtimeName: "VPS @everyone **gras** [clic](https://evil.test)",
    reason: "Aucun signe de vie du lien depuis 45 s.",
    downSince: "2026-10-31T23:13:00.000Z",
    settingsUrl: "https://console.openedbot.test/o/acme/settings/runtime",
    environment: "dev",
  };

  test("a down message names the runtime, the time, the reason and the link, without pinging", () => {
    const message = discordAlertMessage("runtime_link_down", down);
    expect(message.allowed_mentions).toEqual({ parse: [] });
    expect(message.username).toBe("openedbot");
    expect(message.content).toStartWith("🔴 **Runtime injoignable : ");
    expect(message.content).toContain("[dev]");
    expect(message.content).toContain("<t:1793488380:f>");
    expect(message.content).toContain("<t:1793488380:R>");
    expect(message.content).toContain("Raison : Aucun signe de vie du lien depuis 45 s.");
    expect(message.content).toContain("<https://console.openedbot.test/o/acme/settings/runtime>");
    // The organisation's text cannot format, link or mention.
    expect(message.content).toContain("\\*\\*gras\\*\\*");
    expect(message.content).toContain("\\[clic\\]\\(https\\:");
  });

  test("prod carries no tier tag and a missing reason no reason line", () => {
    const message = discordAlertMessage("runtime_link_down", { ...down, environment: "prod", reason: null });
    expect(message.content).not.toContain("[prod]");
    expect(message.content).not.toContain("Raison");
  });

  test("a restored message gives the outage length", () => {
    const message = discordAlertMessage("runtime_link_restored", {
      runtimeName: "VPS",
      downSince: "2026-10-31T23:13:00.000Z",
      restoredAt: "2026-11-01T09:28:00.000Z",
      settingsUrl: "https://console.openedbot.test/o/acme/settings/runtime",
      environment: "prod",
    });
    expect(message.content).toStartWith("🟢 **Runtime rétabli : VPS**");
    expect(message.content).toContain("Panne de 10 h 15 min");
  });

  test("never exceeds Discord's 2000 characters", () => {
    const message = discordAlertMessage("runtime_link_down", { ...down, reason: "x".repeat(5_000) });
    expect(message.content.length).toBeLessThanOrEqual(2_000);
  });

  test("the test message names the channel", () => {
    expect(discordTestMessage("#ops", "preprod").content).toContain("« \\#ops »");
    expect(discordTestMessage("#ops", "preprod").content).toContain("[preprod]");
  });
});

describe("helpers", () => {
  test("escapeDiscordMarkdown neutralises mentions and timestamps", () => {
    expect(escapeDiscordMarkdown("<@123> <t:1:R>")).toBe("\\<@123\\> \\<t\\:1\\:R\\>");
  });

  test("formatOutage", () => {
    expect(formatOutage("2026-11-01T00:00:00Z", "2026-11-01T00:00:20Z")).toBe("1 min");
    expect(formatOutage("2026-11-01T00:00:00Z", "2026-11-01T00:07:00Z")).toBe("7 min");
    expect(formatOutage("2026-11-01T00:00:00Z", "2026-11-01T02:00:00Z")).toBe("2 h");
    expect(formatOutage("2026-11-01T00:00:00Z", "2026-11-03T03:10:00Z")).toBe("2 j 3 h");
  });

  test("classifyDiscordResponse", () => {
    expect(classifyDiscordResponse(204, null)).toEqual({ kind: "sent" });
    expect(classifyDiscordResponse(200, null)).toEqual({ kind: "sent" });
    for (const status of [401, 403, 404]) expect(classifyDiscordResponse(status, null)).toEqual({ kind: "revoked" });
    expect(classifyDiscordResponse(429, 7)).toEqual({ kind: "retry", reason: "rate_limited", delaySeconds: 7 });
    expect(classifyDiscordResponse(503, null)).toEqual({ kind: "retry", reason: "unreachable", delaySeconds: null });
    expect(classifyDiscordResponse(400, null)).toEqual({ kind: "rejected" });
  });

  test("discordRetryAfterSeconds reads the body, then the header, bounded", () => {
    expect(discordRetryAfterSeconds({ retry_after: 0.3 }, "9")).toBe(1);
    expect(discordRetryAfterSeconds({ retry_after: 12.2 }, null)).toBe(13);
    expect(discordRetryAfterSeconds(null, "4")).toBe(4);
    expect(discordRetryAfterSeconds(null, "nope")).toBeNull();
    expect(discordRetryAfterSeconds({ retry_after: 99_999 }, null)).toBe(1_800);
  });

  test("alertRetryDelaySeconds backs off to 30 min", () => {
    expect([1, 2, 3, 4, 5, 6].map(alertRetryDelaySeconds)).toEqual([30, 120, 480, 1_800, 1_800, 1_800]);
  });
});
