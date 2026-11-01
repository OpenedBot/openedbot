import { describe, expect, test } from "bun:test";
import { formatLogLine } from "../src/log-pretty";

describe("log-pretty", () => {
  test("une requête HTTP se lit méthode chemin statut durée, puis ses champs de corrélation", () => {
    const line = formatLogLine({
      level: 30,
      time: 1,
      msg: "http request",
      requestId: "req-1",
      method: "GET",
      path: "/api/bots/42",
      route: "/api/bots/:botId",
      status: 200,
      durationMs: 55,
      organizationId: "org-1",
      userId: "user-1",
    });
    expect(line).toBe("GET /api/bots/42 200 55ms  requestId=req-1 route=/api/bots/:botId organizationId=org-1 userId=user-1");
  });

  test("une entrée quelconque garde son message et rend ses champs en clé=valeur, jamais en bloc JSON", () => {
    const line = formatLogLine({ level: 50, time: 1, msg: "instance heartbeat failed", event: "api.x", error: "boom", features: ["a"] });
    expect(line).toBe('instance heartbeat failed  event=api.x error=boom features=["a"]');
  });

  test("channel et requestId restent des champs clé=valeur, jamais un bloc JSON", () => {
    const line = formatLogLine({
      level: 30,
      time: 1,
      msg: "staff.waitlist_access_granted",
      event: "staff.waitlist_access_granted",
      channel: "staff",
      requestId: "req-1",
      domain: "exemple.test",
    });
    expect(line).toBe(
      "staff.waitlist_access_granted  channel=staff requestId=req-1 domain=exemple.test",
    );
  });
});
