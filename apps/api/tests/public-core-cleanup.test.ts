import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { Db } from "@openedbot/platform-db";
import { readApiConfig } from "../src/infrastructure/config";
import { groupRoutes } from "../src/routes/roster/group-routes";
import { miscRoutes } from "../src/routes/overview/misc-routes";
import { mvpRoutes } from "../src/routes/mvp-routes";

const db = new Proxy({}, { get() { throw new Error("retired endpoint touched the database"); } }) as Db;
test("retired product routes no longer execute SQL", async () => {
  const app = new Hono();
  app.route("/api/groups", groupRoutes(db));
  app.route("/api", miscRoutes(db, { environment: "test" }));
  app.route("/api", mvpRoutes(db));
  for (const path of ["/api/groups", "/api/activation", "/api/usage/bots"]) expect((await app.request(path)).status).toBe(404);
});
test("solo config ignores settings owned by retired transports and private services", () => {
  const config = readApiConfig({ OPENEDBOT_ENV: "test", RUNTIME_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"), BILLING_PRICE_EUR: "invalid", PLAN_MEMBER_LIMIT: "invalid", APNS_KEY_ID: "invalid", PUSH_VAPID_PUBLIC_KEY: "invalid", OPENEDBOT_MANAGED_TUNNEL_URL: "invalid", OPENEDBOT_COMPUTER_BOX_TOKEN: "invalid", NATIVE_API_PUBLIC_URL: "invalid" });
  for (const field of ["plan", "billingPriceEur", "apns", "vapid", "computer", "managedTunnel", "nativeApiPublicUrl"]) expect(field in config).toBe(false);
});
test("retiring push stops its DB producer without deleting historical data", async () => {
  const sql = await Bun.file(new URL("../../../db/migrations/0192_retire_mobile_push.sql", import.meta.url)).text();
  expect(sql).toContain("DROP TRIGGER IF EXISTS workflows_push_notification ON workflows");
  expect(sql).not.toMatch(/DROP TABLE|CASCADE/i);
});
