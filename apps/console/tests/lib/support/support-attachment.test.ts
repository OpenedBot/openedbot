import { afterEach, describe, expect, test } from "bun:test";
import { api } from "../../../src/lib/api";
import { asDesktopBuild } from "../../support/desktop-build";

// These tests drive the desktop app's bridge, which only the desktop build reads.
asDesktopBuild();

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete window.__OPENEDBOT_NATIVE__;
});

function capture(): Array<{ url: string; init: RequestInit | undefined }> {
  const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return new Response(new Blob(["png"]), { status: 200 });
  }) as typeof fetch;
  return seen;
}

describe("api.support.attachment", () => {
  test("dans la coque, un fil retrouvé par le compte présente le bearer du pont, sans cookie", async () => {
    window.__OPENEDBOT_NATIVE__ = {
      readAccessToken: async () => "acces-natif",
      refresh: async () => null,
      openExternal: async () => undefined,
      signOut: async () => undefined,
      shell: { platform: "windows", version: "1.0.0" },
    };
    const seen = capture();
    await api.support.attachment("att-1", null);
    const headers = new Headers(seen[0]!.init?.headers);
    expect(seen[0]!.url).toEndWith("/api/support/attachments/att-1");
    expect(headers.get("Authorization")).toBe("Bearer acces-natif");
    expect(headers.has("X-OpenedBot-Support-Token")).toBe(false);
    expect(seen[0]!.init?.credentials).toBe("omit");
  });

  test("sur le web : le cookie de session, et le jeton du fil s'il y en a un", async () => {
    const seen = capture();
    await api.support.attachment("att-2", "jeton-du-fil");
    const headers = new Headers(seen[0]!.init?.headers);
    expect(headers.has("Authorization")).toBe(false);
    expect(headers.get("X-OpenedBot-Support-Token")).toBe("jeton-du-fil");
    expect(seen[0]!.init?.credentials).toBe("include");
  });

  test("un refus devient une erreur, pas une image vide", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 401 })) as unknown as typeof fetch;
    await expect(api.support.attachment("att-3", null)).rejects.toMatchObject({ status: 401 });
  });
});
