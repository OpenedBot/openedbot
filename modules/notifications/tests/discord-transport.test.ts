import { describe, expect, test } from "bun:test";
import { createDiscordTransport, DiscordTransportError } from "../src/application/discord-transport";
import { discordTestMessage } from "../src/domain/alert-channels";

const URL = `https://discord.com/api/webhooks/1459685375038591192/${"t".repeat(68)}`;

function fakeFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { impl, calls };
}

describe("createDiscordTransport", () => {
  test("posts the message as JSON and refuses redirects", async () => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const result = await createDiscordTransport(impl).post(URL, discordTestMessage("#ops", "dev"));
    expect(result).toEqual({ status: 204, retryAfterSeconds: null });
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.redirect).toBe("error");
    expect(JSON.parse(String(calls[0]!.init.body)).allowed_mentions).toEqual({ parse: [] });
  });

  test("a 429 carries Discord's retry_after", async () => {
    const { impl } = fakeFetch(() => Response.json({ retry_after: 2.5, global: false }, { status: 429 }));
    expect(await createDiscordTransport(impl).post(URL, discordTestMessage("x", "dev")))
      .toEqual({ status: 429, retryAfterSeconds: 3 });
  });

  test("inspect reads the webhook name, and nothing on an error", async () => {
    const ok = fakeFetch(() => Response.json({ name: "Alertes openedbot", token: "secret" }));
    expect(await createDiscordTransport(ok.impl).inspect(URL)).toEqual({ status: 200, name: "Alertes openedbot" });
    expect(ok.calls[0]!.init.method).toBe("GET");
    const gone = fakeFetch(() => Response.json({ message: "Unknown Webhook", code: 10015 }, { status: 404 }));
    expect(await createDiscordTransport(gone.impl).inspect(URL)).toEqual({ status: 404, name: null });
  });

  test("a network failure or a timeout is a DiscordTransportError that never names the URL", async () => {
    const down = fakeFetch(() => { throw new TypeError(`fetch failed for ${URL}`); });
    const error = await createDiscordTransport(down.impl).post(URL, discordTestMessage("x", "dev")).catch((caught) => caught);
    expect(error).toBeInstanceOf(DiscordTransportError);
    expect((error as DiscordTransportError).code).toBe("network");
    expect(String((error as Error).message)).not.toContain("webhooks");

    const slow = fakeFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    }));
    const timeout = await createDiscordTransport(slow.impl, 20).inspect(URL).catch((caught) => caught);
    expect(timeout).toBeInstanceOf(DiscordTransportError);
    expect((timeout as DiscordTransportError).code).toBe("timeout");
  });
});
