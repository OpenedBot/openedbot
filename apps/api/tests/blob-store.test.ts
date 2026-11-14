import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import type { SQL } from "bun";
import { BlobDriverUnavailableError, createBlobStore } from "../src/infrastructure/blob-store";
import { attachmentRoutes } from "../src/routes/conversation/attachment-routes";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import { HttpError } from "../src/interfaces/http/http-error";

const ORG = "11111111-1111-4111-8111-111111111111";
const KEY = `org/${ORG}/22222222-2222-4222-8222-222222222222`;
const r2 = {
  driver: "r2" as const, bucket: "b", endpoint: "https://r2.example", accessKeyId: "k", secretAccessKey: "s",
  cdnUrl: "https://files.example", cdnSigningKey: "signing-key",
};
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function diskWith(key: string, text: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openedbot-api-blob-"));
  roots.push(root);
  await mkdir(dirname(join(root, key)), { recursive: true });
  await Bun.write(join(root, key), text);
  return root;
}

describe("magasin de blobs après une bascule de driver", () => {
  test("R2 écrit, un objet du disque reste lu sur le disque et sans redirection CDN", async () => {
    const root = await diskWith(KEY, "ancien");
    const blobs = createBlobStore(r2, { driver: "file", root });
    expect(blobs.driver).toBe("r2");
    expect(await (await blobs.get(KEY, "file")).text()).toBe("ancien");
    expect(blobs.deliveryUrl(KEY, "file")).toBeNull();
    expect(blobs.deliveryUrl(KEY, "r2")).toStartWith("https://files.example/files/");
    await blobs.delete(KEY, "file");
    expect(await Bun.file(join(root, KEY)).exists()).toBe(false);
  });

  test("un objet d'un magasin injoignable est refusé, jamais cherché ailleurs", async () => {
    const root = await diskWith(KEY, "x");
    const blobs = createBlobStore({ driver: "file", root }, null);
    expect(() => blobs.deliveryUrl(KEY, "r2")).toThrow(BlobDriverUnavailableError);
    await expect(blobs.delete(KEY, "r2")).rejects.toBeInstanceOf(BlobDriverUnavailableError);
    await expect(blobs.get(KEY, "r2")).rejects.toBeInstanceOf(BlobDriverUnavailableError);
    expect(await Bun.file(join(root, KEY)).exists()).toBe(true);
  });

  test("GET /attachments/:id sert le fichier par le driver de sa ligne", async () => {
    const root = await diskWith(KEY, "contenu disque");
    const db = (async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (sql.includes("set_config")) return [];
      return [{ objectKey: KEY, contentType: "text/plain", name: "a.txt", driver: "file" }];
    }) as unknown as SQL;
    (db as unknown as { begin: (fn: (tx: SQL) => unknown) => unknown }).begin = (fn) => fn(db);
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", async (context, next) => { context.set("auth", { organizationId: ORG } as AuthContext); await next(); });
    app.onError((error, context) => error instanceof HttpError
      ? context.json({ error: { code: error.code } }, error.status as 503)
      : context.json({ error: { code: "UNEXPECTED" } }, 500));
    app.route("/", attachmentRoutes(db, createBlobStore(r2, { driver: "file", root })));
    const served = await app.request("/att-1");
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("contenu disque");

    const unreachable = new Hono<{ Variables: AppVariables }>();
    unreachable.use("*", async (context, next) => { context.set("auth", { organizationId: ORG } as AuthContext); await next(); });
    unreachable.onError((error, context) => error instanceof HttpError
      ? context.json({ error: { code: error.code } }, error.status as 503)
      : context.json({ error: { code: "UNEXPECTED" } }, 500));
    const r2Row = (async (strings: TemplateStringsArray) => strings.join("?").includes("set_config")
      ? []
      : [{ objectKey: KEY, contentType: "text/plain", name: "a.txt", driver: "r2" }]) as unknown as SQL;
    (r2Row as unknown as { begin: (fn: (tx: SQL) => unknown) => unknown }).begin = (fn) => fn(r2Row);
    unreachable.route("/", attachmentRoutes(r2Row, createBlobStore({ driver: "file", root }, null)));
    const refused = await unreachable.request("/att-1");
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: { code: "ATTACHMENT_STORAGE_UNAVAILABLE" } });
  });
});
