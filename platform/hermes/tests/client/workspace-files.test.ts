import { describe, expect, test } from "bun:test";
import { HermesClient, HermesClientError } from "../../src/index";
import type { HermesTransport } from "../../src/transport/types";

function transportWith(reply: (path: string) => Response) {
  const paths: string[] = [];
  const transport: HermesTransport = { kind: "relay", async send(path, init, kind) {
    paths.push(path);
    expect(init.method).toBe("GET"); expect(kind).toBe("safe");
    return reply(path);
  } };
  return { transport, paths };
}
const png = new Uint8Array([137,80,78,71,13,10,26,10]);

describe("workspace artifacts stay on their owning profile", () => {
  test("a named profile uses the exact host route without a /p prefix", async () => {
    const { transport, paths } = transportWith(() => new Response(png, { headers: { "content-type": "image/png" } }));
    const file = await new HermesClient({ transport, profile: "alpha" }).hostWorkspaceFile("chart.png");
    expect(paths).toEqual(["/hermes-setup/profiles/alpha/workspace/files/chart.png"]);
    expect(file.bytes).toEqual(png);
  });
  test("a client with no profile retains the root file route", async () => {
    const { transport, paths } = transportWith(() => new Response(png, { headers: { "content-type": "image/png" } }));
    await new HermesClient({ transport }).hostWorkspaceFile("chart.png");
    expect(paths).toEqual(["/hermes-setup/workspace/files/chart.png"]);
  });
  test("an older or unproven host never triggers a root fallback", async () => {
    for (const status of [404, 409]) {
      const { transport, paths } = transportWith(() => Response.json({ error: { code: "PROFILE_WORKSPACE_UNVERIFIED", message: "not proven" } }, { status }));
      await expect(new HermesClient({ transport, profile: "alpha" }).hostWorkspaceFile("chart.png")).rejects.toBeInstanceOf(HermesClientError);
      expect(paths).toEqual(["/hermes-setup/profiles/alpha/workspace/files/chart.png"]);
    }
  });
  test("invalid profile names and file paths fail before transport", async () => {
    const { transport, paths } = transportWith(() => new Response(png));
    for (const name of ["../chart.png", "sub/chart.png", "chart.PNG", ".hidden.png"]) {
      await expect(new HermesClient({ transport, profile: "alpha" }).hostWorkspaceFile(name)).rejects.toBeInstanceOf(HermesClientError);
    }
    for (const profile of ["default", "../beta", "a/b", "UPPER"]) {
      await expect(new HermesClient({ transport, profile }).hostWorkspaceFile("chart.png")).rejects.toBeInstanceOf(HermesClientError);
    }
    expect(paths).toEqual([]);
  });
  test("the same name in two profiles returns independent artifact bytes", async () => {
    const { transport } = transportWith((path) => new Response(path.includes("/alpha/") ? "%PDF-alpha" : "%PDF-beta", { headers: { "content-type": "application/pdf" } }));
    const alpha = await new HermesClient({ transport, profile: "alpha" }).hostWorkspaceFile("same.pdf");
    const beta = await new HermesClient({ transport, profile: "beta" }).hostWorkspaceFile("same.pdf");
    expect(new TextDecoder().decode(alpha.bytes)).toBe("%PDF-alpha");
    expect(new TextDecoder().decode(beta.bytes)).toBe("%PDF-beta");
  });
});
