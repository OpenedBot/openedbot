import { describe, expect, test } from "bun:test";
import http2 from "node:http2";
import { fakeApnsDevEnv, startFakeApns } from "./server";

function post(url: string, path: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const client = http2.connect(url);
    client.on("error", reject);
    const stream = client.request({ ":method": "POST", ":path": path, ...headers });
    let status = 0;
    let data = "";
    stream.on("response", (response) => { status = Number(response[":status"]); });
    stream.on("data", (chunk: Buffer) => { data += chunk.toString("utf8"); });
    stream.on("end", () => {
      client.close();
      resolve({ status, body: data });
    });
    stream.on("error", reject);
    stream.end(body);
  });
}

const BEARER = `bearer ${Buffer.from(JSON.stringify({ alg: "ES256", kid: "FAKEKEY001" })).toString("base64url")}.${Buffer.from(JSON.stringify({ iss: "FAKETEAM01", iat: Math.floor(Date.now() / 1_000) })).toString("base64url")}.c2ln`;

describe("fake-apns", () => {
  test("answers 200, then the scripted error once, and checks the APNs headers", async () => {
    const server = await startFakeApns({ port: 0 });
    try {
      const headers = { authorization: BEARER, "apns-topic": "app.openedbot.mobile", "apns-push-type": "alert" };
      const payload = JSON.stringify({ aps: { alert: { title: "t", body: "b" } } });
      expect((await post(server.url, "/3/device/ab12", headers, payload)).status).toBe(200);

      server.script({ status: 410, reason: "Unregistered" });
      const gone = await post(server.url, "/3/device/ab12", headers, payload);
      expect(gone.status).toBe(410);
      expect(JSON.parse(gone.body).reason).toBe("Unregistered");
      expect((await post(server.url, "/3/device/ab12", headers, payload)).status).toBe(200);

      const missing = await post(server.url, "/3/device/ab12", { authorization: BEARER, "apns-push-type": "alert" }, payload);
      expect(missing.status).toBe(400);
      expect(JSON.parse(missing.body).reason).toBe("MissingTopic");
      const unsigned = await post(server.url, "/3/device/ab12", { "apns-topic": "x.y", "apns-push-type": "alert" }, payload);
      expect(unsigned.status).toBe(403);

      expect(server.journal().map((delivery) => delivery.status)).toEqual([200, 410, 200, 400, 403]);
    } finally {
      await server.stop();
    }
  });

  test("--dev-key prints a complete, parseable APNS_* block", () => {
    const lines = fakeApnsDevEnv(18_793).split("\n");
    expect(lines.map((line) => line.split("=")[0])).toEqual([
      "APNS_KEY_ID", "APNS_TEAM_ID", "APNS_PRIVATE_KEY", "APNS_BUNDLE_IDS", "APNS_HOST_OVERRIDE",
    ]);
    expect(lines[2]).toContain("BEGIN PRIVATE KEY");
    expect(lines[4]).toBe("APNS_HOST_OVERRIDE=http://127.0.0.1:18793");
  });
});
