import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRunImages } from "../../src/application/runner/history";

const ORG = "11111111-1111-4111-8111-111111111111";
const ATTACHMENT = "22222222-2222-4222-8222-222222222222";
const root = mkdtempSync(join(tmpdir(), "run-images-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fakeDb(calls: string[]): Bun.SQL {
  const db = ((strings: TemplateStringsArray | string[]) => {
    if (!Array.isArray(strings) || !("raw" in strings)) return strings;
    const sql = [...strings].join(" ");
    calls.push(sql);
    if (sql.includes("from runs run") && sql.includes("join messages message")) {
      // La relance n'a aucun message à elle : seul le message d'origine,
      // désigné par `runs.source_message_id`, porte la puce image.
      return Promise.resolve(sql.includes("message.id = run.source_message_id")
        ? [{ content: [{ type: "attachment", id: ATTACHMENT, name: "schema.png", contentType: "image/png", kind: "image" }] }]
        : []);
    }
    if (sql.includes("from attachments")) {
      return Promise.resolve([{ id: ATTACHMENT, objectKey: `org/${ORG}/${ATTACHMENT}`, name: "schema.png", contentType: "image/png" }]);
    }
    return Promise.resolve([]);
  }) as unknown as Bun.SQL;
  return db;
}

describe("loadRunImages", () => {
  test("une relance relit les images du message source, pas une conversation dupliquée", async () => {
    mkdirSync(join(root, "org", ORG), { recursive: true });
    writeFileSync(join(root, "org", ORG, ATTACHMENT), new Uint8Array([137, 80, 78, 71]));
    const calls: string[] = [];

    const result = await loadRunImages(
      fakeDb(calls),
      { id: "retry-run", organizationId: ORG },
      { driver: "file", root } as never,
    );

    expect(result.missing).toEqual([]);
    expect(result.images).toEqual([{ name: "schema.png", dataUrl: "data:image/png;base64,iVBORw==" }]);
    const read = calls.find((sql) => sql.includes("join messages message"));
    // Le message lié au run passe d'abord ; la provenance n'est qu'un repli.
    expect(read).toContain("order by (message.run_id is not distinct from run.id) desc");
  });
});
