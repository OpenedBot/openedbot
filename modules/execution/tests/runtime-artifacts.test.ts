import { describe, expect, test } from "bun:test";
import { ATTACHMENT_LIMITS } from "@openedbot/conversation/domain/attachments";
import { isSensitiveRuntimePath, projectRuntimeArtifacts } from "../src/domain/runtime-artifacts";

function writeCall(path: string, content: string, name = "write_file") {
  return {
    role: "assistant",
    tool_calls: [{ function: { name, arguments: JSON.stringify({ path, content }) } }],
  };
}

describe("isSensitiveRuntimePath", () => {
  test("écarte secrets, env et clés", () => {
    expect(isSensitiveRuntimePath("/root/.env")).toBe(true);
    expect(isSensitiveRuntimePath("/root/.env.local")).toBe(true);
    expect(isSensitiveRuntimePath("/home/x/.ssh/id_ed25519")).toBe(true);
    expect(isSensitiveRuntimePath("/root/secrets/token")).toBe(true);
    expect(isSensitiveRuntimePath("/root/cert.pem")).toBe(true);
    expect(isSensitiveRuntimePath("/root/.hermes/.env")).toBe(true);
    expect(isSensitiveRuntimePath("/root/actualite-ia-semaine.html")).toBe(false);
  });
});

describe("projectRuntimeArtifacts", () => {
  test("attache un HTML écrit par write_file", () => {
    const html = "<!doctype html><html><body>semaine</body></html>";
    const artifacts = projectRuntimeArtifacts([
      writeCall("/root/actualite-ia-semaine.html", html),
    ]);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      path: "/root/actualite-ia-semaine.html",
      name: "actualite-ia-semaine.html",
      contentType: "text/html",
      kind: "document",
    });
    expect(new TextDecoder().decode(artifacts[0]!.data)).toBe(html);
  });

  test("déplie une écriture derrière le bridge tool_call", () => {
    const artifacts = projectRuntimeArtifacts([{
      role: "assistant",
      tool_calls: [{
        function: {
          name: "tool_call",
          arguments: JSON.stringify({ calls: [{
            name: "write_file",
            arguments: { path: "/root/bridge.html", content: "<p>bridge</p>" },
          }] }),
        },
      }],
    }]);
    expect(artifacts[0]?.name).toBe("bridge.html");
  });

  test("la dernière écriture d'un chemin l'emporte", () => {
    const artifacts = projectRuntimeArtifacts([
      writeCall("/root/page.html", "<p>un</p>"),
      writeCall("/root/page.html", "<p>deux</p>"),
    ]);
    expect(artifacts).toHaveLength(1);
    expect(new TextDecoder().decode(artifacts[0]!.data)).toBe("<p>deux</p>");
  });

  test("ignore un chemin sensible même en .html", () => {
    expect(projectRuntimeArtifacts([writeCall("/root/.env.html", "<p>x</p>")])).toEqual([]);
    expect(projectRuntimeArtifacts([writeCall("/root/.hermes/note.html", "<p>x</p>")])).toEqual([]);
  });

  test("ignore un type hors liste et un fichier trop gros", () => {
    expect(projectRuntimeArtifacts([writeCall("/root/notes.md", "# hi")])).toEqual([]);
    const huge = "x".repeat(ATTACHMENT_LIMITS.maxBytesEach + 1);
    expect(projectRuntimeArtifacts([writeCall("/root/big.html", huge)])).toEqual([]);
  });

  test("ignore un write sans contenu : un diff n'est pas un fichier", () => {
    const messages = [{
      role: "assistant",
      tool_calls: [{
        function: {
          name: "write_file",
          arguments: JSON.stringify({ path: "/root/page.html" }),
        },
      }],
    }];
    expect(projectRuntimeArtifacts(messages)).toEqual([]);
  });

  test("lit aussi la forme OpenAI à plat et une image data-URI", () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const messages = [{
      role: "assistant",
      tool_calls: [{
        name: "write_file",
        arguments: { path: "/tmp/dot.png", content: `data:image/png;base64,${png}` },
      }],
    }];
    const artifacts = projectRuntimeArtifacts(messages);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      name: "dot.png",
      contentType: "image/png",
      kind: "image",
    });
    expect(artifacts[0]!.data.byteLength).toBeGreaterThan(0);
  });

  test("plafonne le nombre de puces", () => {
    const messages = Array.from({ length: ATTACHMENT_LIMITS.maxCount + 2 }, (_, index) =>
      writeCall(`/root/p${index}.html`, `<p>${index}</p>`),
    );
    expect(projectRuntimeArtifacts(messages)).toHaveLength(ATTACHMENT_LIMITS.maxCount);
  });

  test("une entrée qui n'est pas une liste ne produit rien", () => {
    expect(projectRuntimeArtifacts(null)).toEqual([]);
    expect(projectRuntimeArtifacts({ data: [] })).toEqual([]);
  });
});
