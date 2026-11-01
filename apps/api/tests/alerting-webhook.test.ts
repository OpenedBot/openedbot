import { describe, expect, test } from "bun:test";
import { alertWebhookBody, deployEnvironment } from "../src/alerting/monitor";

/**
 * Le webhook d'alerte doit rester lisible par un récepteur maison (champs
 * structurés) ET accepté par Discord, qui refuse 400 un corps sans `content`.
 */
describe("alertWebhookBody", () => {
  test("keeps the structured fields and adds a Discord-readable content line", () => {
    const body = alertWebhookBody({ status: "firing", reasons: ["API injoignable", "worker sans heartbeat"], occurredAt: "2026-09-06T18:00:00.000Z" }, { environment: "prod", host: "console.openedbot.app" });
    expect(body.event).toBe("ohb.alert");
    expect(body.status).toBe("firing");
    expect(body.reasons).toEqual(["API injoignable", "worker sans heartbeat"]);
    expect(body.content).toBe("🔴 openedbot alerte [prod · console.openedbot.app] : API injoignable ; worker sans heartbeat (2026-09-06T18:00:00.000Z)");
    expect(body.environment).toBe("prod");
    expect(body.host).toBe("console.openedbot.app");
  });

  test("a resolution names itself and never exceeds Discord's 2000-character limit", () => {
    const body = alertWebhookBody({ status: "resolved", reasons: [], occurredAt: "2026-09-06T18:05:00.000Z" }, { environment: "dev", host: "localhost:8790" });
    expect(String(body.content).startsWith("🟢 openedbot rétablie [dev · localhost:8790] : aucune raison")).toBe(true);
    const long = alertWebhookBody({ status: "firing", reasons: ["x".repeat(5000)], occurredAt: "now" }, { environment: "preprod", host: "alpha.example" });
    expect(String(long.content).length).toBe(2000);
  });
});

describe("deployEnvironment", () => {
  test("explicit tier wins, production defaults to prod, anything else to dev", () => {
    expect(deployEnvironment("preprod", "production")).toBe("preprod");
    expect(deployEnvironment(undefined, "production")).toBe("prod");
    expect(deployEnvironment("", "development")).toBe("dev");
    expect(() => deployEnvironment("staging", "production")).toThrow(/dev, preprod or prod/u);
  });
});
