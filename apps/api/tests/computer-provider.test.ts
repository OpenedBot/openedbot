import { describe, expect, test } from "bun:test";
import {
  BoxComputerProvider,
  ComputerProviderError,
  createComputerProvider,
} from "../src/infrastructure/computer-provider";

const config = {
  provider: "box" as const,
  apiUrl: "https://provider.example/v1",
  token: "box_secret",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Computer providers", () => {
  test("disabled stays fail-closed", async () => {
    const provider = createComputerProvider({ provider: "disabled" });
    expect(await provider.status("org:bot")).toEqual({ configured: false, state: "off", providerState: null });
    expect(provider.start("org:bot", "Scout")).rejects.toMatchObject({
      status: 409,
      code: "COMPUTER_PROVIDER_DISABLED",
    });
  });

  test("runs a real persistent Box lifecycle without exposing the token", async () => {
    let box: { id: string; name: string; state: string } | null = null;
    const calls: Array<{ path: string; method: string; authorization: string | null }> = [];
    const jpeg = Uint8Array.from([0xff, 0xd8, ...Array.from({ length: 16 }, () => 0), 0xff, 0xd9]);
    const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      calls.push({ path: `${url.pathname}${url.search}`, method, authorization: headers.get("authorization") });
      if (url.pathname.endsWith("/boxes") && method === "GET") return json({ boxes: box ? [box] : [] });
      if (url.pathname.endsWith("/boxes") && method === "POST") {
        expect(JSON.parse(String(init?.body))).toEqual({ ttlSeconds: 28_800, noEnv: true });
        expect(headers.get("Idempotency-Key")).toMatch(/^openedbot-computer-/);
        box = { id: "box-1", name: "pending", state: "starting" };
        return json({ box });
      }
      if (url.pathname.endsWith("/boxes/box-1") && method === "PATCH") {
        box = { ...box!, name: JSON.parse(String(init?.body)).name, state: "ready" };
        return json({ box });
      }
      if (url.pathname.endsWith("/boxes/box-1") && method === "GET") return json({ box });
      if (url.pathname.endsWith("/boxes/box-1/desktop") && method === "POST") {
        return json({ desktopUrl: "https://desktop.example/session/rotating-token" });
      }
      if (url.pathname.endsWith("/boxes/box-1/commands") && method === "POST") {
        const command = JSON.parse(String(init?.body)).command as string;
        expect(command).toContain("OPENEDBOT_CAPTURED");
        expect(command).not.toContain("box_secret");
        return json({ exitCode: 0, stdout: "OPENEDBOT_CAPTURED\n", stderr: "" });
      }
      if (url.pathname.endsWith("/boxes/box-1/artifacts") && method === "GET") return new Response(jpeg);
      if (url.pathname.endsWith("/boxes/box-1/stop") && method === "POST") {
        box = { ...box!, state: "archived" };
        return json({ ok: true });
      }
      return json({ error: "not found" }, 404);
    };
    const provider = new BoxComputerProvider(config, fetcher);

    expect(await provider.status("org-1:bot-1")).toMatchObject({ state: "off", configured: true });
    expect(await provider.start("org-1:bot-1", "Scout")).toMatchObject({ state: "ready" });
    expect(await provider.open("org-1:bot-1")).toEqual({
      url: "https://desktop.example/session/rotating-token",
    });
    const capture = await provider.capture("org-1:bot-1");
    expect(capture.mediaType).toBe("image/jpeg");
    expect(new Uint8Array(Buffer.from(capture.base64, "base64"))).toEqual(jpeg);
    expect(await provider.stop("org-1:bot-1")).toMatchObject({ state: "off", providerState: "archived" });
    const stopIndex = calls.findIndex((call) => call.path.endsWith("/boxes/box-1/stop"));
    expect(calls.slice(stopIndex + 1).some((call) => call.path.endsWith("/boxes/box-1") && call.method === "GET"))
      .toBe(true);
    expect(calls.every((call) => call.authorization === "Bearer box_secret")).toBe(true);
    expect(JSON.stringify(calls)).not.toContain("rotating-token");
  });

  test("serializes start then stop so the last command deterministically leaves the box off", async () => {
    let box: { id: string; name: string; state: string } | null = null;
    let createEnteredResolve!: () => void;
    const createEntered = new Promise<void>((resolve) => { createEnteredResolve = resolve; });
    const allowCreate = deferred();
    const calls: string[] = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}`);
      if (url.pathname.endsWith("/boxes") && method === "GET") return json({ boxes: box ? [box] : [] });
      if (url.pathname.endsWith("/boxes") && method === "POST") {
        createEnteredResolve();
        await allowCreate.promise;
        box = { id: "box-race", name: "pending", state: "starting" };
        return json({ box });
      }
      if (url.pathname.endsWith("/boxes/box-race") && method === "PATCH") {
        box = { ...box!, name: JSON.parse(String(init?.body)).name, state: "ready" };
        return json({ box });
      }
      if (url.pathname.endsWith("/boxes/box-race") && method === "GET") return json({ box });
      if (url.pathname.endsWith("/boxes/box-race/stop") && method === "POST") {
        box = { ...box!, state: "archived" };
        return json({ ok: true });
      }
      return json({ error: "not found" }, 404);
    };
    const provider = new BoxComputerProvider(config, fetcher);

    const start = provider.start("org:bot", "Scout");
    await createEntered;
    const stop = provider.stop("org:bot");
    await Promise.resolve();
    expect(calls.some((call) => call.endsWith("/boxes/box-race/stop"))).toBe(false);

    allowCreate.resolve();
    expect(await start).toMatchObject({ state: "ready" });
    expect(await stop).toMatchObject({ state: "off", providerState: "archived" });
    expect(await provider.status("org:bot")).toMatchObject({ state: "off" });
    expect(calls.findIndex((call) => call.endsWith("/boxes/box-race/stop")))
      .toBeGreaterThan(calls.findIndex((call) => call === "PATCH /v1/boxes/box-race"));
  });

  test("rejects an insecure desktop URL instead of handing it to the browser", async () => {
    const provider = new BoxComputerProvider(config, async (input, init) => {
      const url = new URL(String(input));
      if ((init?.method ?? "GET") === "GET" && url.pathname.endsWith("/boxes")) {
        return json({ boxes: [{ id: "box-1", name: "openedbot-ignored", state: "ready" }] });
      }
      if ((init?.method ?? "GET") === "GET" && url.pathname.endsWith("/boxes/box-1")) {
        return json({ box: { id: "box-1", state: "ready" } });
      }
      return json({ desktopUrl: "http://desktop.example/session" });
    });
    // Seed the private id cache through a successful start/status lookup is
    // deliberately impossible without the deterministic name. A tiny provider
    // fixture creates and names the box instead.
    const seeded = new BoxComputerProvider(config, async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.pathname.endsWith("/boxes") && method === "GET") return json({ boxes: [] });
      if (url.pathname.endsWith("/boxes") && method === "POST") return json({ box: { id: "box-1", state: "ready" } });
      if (url.pathname.endsWith("/boxes/box-1") && method === "PATCH") return json({ box: { id: "box-1", state: "ready" } });
      if (url.pathname.endsWith("/boxes/box-1") && method === "GET") return json({ box: { id: "box-1", state: "ready" } });
      return json({ desktopUrl: "http://desktop.example/session" });
    });
    await seeded.start("org:bot", "Scout");
    expect(seeded.open("org:bot")).rejects.toMatchObject({
      code: "COMPUTER_PROVIDER_RESPONSE_INVALID",
    });
    void provider;
  });

  test("maps provider authentication errors to a sanitized deployment error", async () => {
    const provider = new BoxComputerProvider(config, async () => json({ secret: "upstream detail" }, 401));
    try {
      await provider.status("org:bot");
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ComputerProviderError);
      expect(error).toMatchObject({ status: 502, code: "COMPUTER_PROVIDER_AUTH_FAILED" });
      expect((error as Error).message).not.toContain("upstream detail");
      expect((error as Error).message).not.toContain("box_secret");
    }
  });

  test("coupe une réponse chunked dès la limite au lieu de la bufferiser entièrement", async () => {
    let cancelled = false;
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(700_000));
        controller.enqueue(new Uint8Array(700_000));
      },
      cancel() { cancelled = true; },
    });
    const provider = new BoxComputerProvider(config, async () => new Response(oversized));

    await expect(provider.status("org:bot")).rejects.toMatchObject({
      code: "COMPUTER_PROVIDER_RESPONSE_INVALID",
    });
    expect(cancelled).toBe(true);
  });
});
