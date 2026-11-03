import { describe, expect, test } from "bun:test";
import { extractOutputMedia, workspaceMediaNames } from "../src/domain/output-media";
import { withoutMediaLines } from "../src/domain/output-media-text";
import { fetchWorkspaceMedia } from "../src/application/runner/output-media-fetch";

// A 1×1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("extractOutputMedia", () => {
  test("an image Hermes inlined from MEDIA: becomes an attachment, and leaves the text", () => {
    const media = extractOutputMedia(`Voici le résumé en une image :\n\n![image](data:image/png;base64,${PNG})\n\nElle reprend le schéma.`);
    expect(media.text).toBe("Voici le résumé en une image :\n\nElle reprend le schéma.");
    expect(media.images).toHaveLength(1);
    expect(media.images[0]).toMatchObject({ name: "image.png", contentType: "image/png", kind: "image" });
    expect(media.images[0]!.data.byteLength).toBeGreaterThan(60);
    expect(media.unresolved).toEqual([]);
  });

  test("a MEDIA: line the host could not read keeps only the file's name, never the server path", () => {
    const media = extractOutputMedia("Voici le résumé en une image :\n\nMEDIA:/tmp/out/superagent.png\n\nElle reprend le schéma.");
    expect(media.text).toBe("Voici le résumé en une image :\n\n`superagent.png`\n\nElle reprend le schéma.");
    expect(media.text).not.toContain("/tmp/out");
    expect(media.images).toEqual([]);
    expect(media.unresolved).toEqual(["superagent.png"]);
  });

  test("several images keep their order and get distinct names", () => {
    const media = extractOutputMedia(`![image](data:image/png;base64,${PNG}) puis ![Schéma final](data:image/png;base64,${PNG})`);
    expect(media.images.map((image) => image.name)).toEqual(["image.png", "Schéma final.png"]);
    expect(media.text).toBe("puis");
  });

  test("a type the thread cannot show, or broken bytes, keep a name and drop the base64", () => {
    const svg = extractOutputMedia("![image](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)");
    expect(svg.images).toEqual([]);
    expect(svg.text).not.toContain("base64");
    const broken = extractOutputMedia("![image](data:image/png;base64,@@@@)");
    expect(broken.text).not.toContain("data:");
  });

  test("prose and ordinary replies stay untouched", () => {
    for (const reply of ["Le préfixe MEDIA: sert aux passerelles.", "Rien à joindre.", ""]) {
      expect(extractOutputMedia(reply)).toEqual({ text: reply, images: [], unresolved: [] });
    }
    expect(extractOutputMedia(null).text).toBe("");
  });

  test("a MEDIA: file at the root of /workspace is read from the host and attached", () => {
    const output = "Voici :\n\nMEDIA:/workspace/ok_openedbot.png\n\nEt le rapport MEDIA:/workspace/rapport.pdf.";
    expect(workspaceMediaNames(output)).toEqual(["ok_openedbot.png", "rapport.pdf"]);
    const png = new Uint8Array(Buffer.from(PNG, "base64"));
    const media = extractOutputMedia(output, new Map([
      ["ok_openedbot.png", { contentType: "image/png" as const, bytes: png }],
      ["rapport.pdf", { contentType: "application/pdf" as const, bytes: new TextEncoder().encode("%PDF-1.7") }],
    ]));
    expect(media.text).toBe("Voici :\n\nEt le rapport");
    expect(media.images.map((file) => [file.name, file.kind, file.contentType])).toEqual([
      ["ok_openedbot.png", "image", "image/png"],
      ["rapport.pdf", "document", "application/pdf"],
    ]);
    expect(media.unresolved).toEqual([]);
  });

  test("only a plain name at the root of /workspace is asked of the host", () => {
    expect(workspaceMediaNames("MEDIA:/tmp/a.png MEDIA:/workspace/sub/b.png MEDIA:/workspace/.env.png MEDIA:/workspace/c.txt")).toEqual([]);
    expect(workspaceMediaNames("MEDIA:/workspace/a.png\nMEDIA:/workspace/a.png")).toEqual(["a.png"]);
    const many = Array.from({ length: 9 }, (_, index) => `MEDIA:/workspace/f${index}.png`).join("\n");
    expect(workspaceMediaNames(many)).toHaveLength(5);
  });

  test("a file the host could not serve keeps its name, and one named twice is attached once", () => {
    const png = new Uint8Array(Buffer.from(PNG, "base64"));
    const media = extractOutputMedia("MEDIA:/workspace/a.png\nMEDIA:/workspace/missing.png\nMEDIA:/workspace/a.png", new Map([
      ["a.png", { contentType: "image/png" as const, bytes: png }],
    ]));
    expect(media.images).toHaveLength(1);
    expect(media.text).toBe("`missing.png`");
    expect(media.unresolved).toEqual(["missing.png"]);
  });

  test("a failed host read is logged and leaves the others", async () => {
    const png = new Uint8Array(Buffer.from(PNG, "base64"));
    const client = {
      hostWorkspaceFile: async (name: string) => {
        if (name === "a.png") return { contentType: "image/png" as const, bytes: png };
        throw Object.assign(new Error("absent"), { status: 404, code: "HERMES_OPERATOR_UNAVAILABLE" });
      },
    };
    const context = { id: "run-1", organizationId: "org-1" };
    const fetched = await fetchWorkspaceMedia(context, client, ["a.png", "b.png"]);
    expect([...fetched.keys()]).toEqual(["a.png"]);
    expect((await fetchWorkspaceMedia(context, undefined, ["a.png"])).size).toBe(0);
  });

  test("the streamed text hides an attached file's line, names a missing one, and hides a tag still arriving", () => {
    const attached = new Set(["vert_ok.png"]);
    expect(withoutMediaLines("Voici :\n\nMEDIA:/workspace/vert_ok.png\n\nFin.", attached)).toBe("Voici :\n\nFin.");
    expect(withoutMediaLines("Voici :\nMEDIA:/tmp/out/perdu.png\nFin.", attached)).toBe("Voici :\n`perdu.png`\nFin.");
    expect(withoutMediaLines("Voici :\n\nMEDIA:/workspace/ve", null)).toBe("Voici :");
    expect(withoutMediaLines("Voici :\n\nMEDIA:/workspace/fin.png", attached)).toBe("Voici :\n\n`fin.png`");
    expect(withoutMediaLines("Le préfixe MEDIA: sert aux passerelles.", attached)).toBe("Le préfixe MEDIA: sert aux passerelles.");
  });
});

