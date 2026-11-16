import { describe, expect, test } from "bun:test";
import { citedWorkspacePaths, deliverableType, writtenWorkspaceText } from "../src/domain/output-workspace-files";

describe("citedWorkspacePaths", () => {
  test("reads a path in inline code and in prose, punctuation after it excluded", () => {
    expect(citedWorkspacePaths("Le fichier `/workspace/notes.md` contient trois lignes.")).toEqual(["notes.md"]);
    expect(citedWorkspacePaths("J'ai écrit /workspace/notes.md.")).toEqual(["notes.md"]);
    expect(citedWorkspacePaths("Voir /workspace/notes.md, puis /workspace/data.csv; enfin /workspace/a.json !")).toEqual(["notes.md", "data.csv", "a.json"]);
    expect(citedWorkspacePaths("C'est prêt (/workspace/rapport.pdf).")).toEqual(["rapport.pdf"]);
    expect(citedWorkspacePaths("Ouvre **/workspace/notes.md** ou [ce lien](/workspace/b.txt)")).toEqual(["notes.md", "b.txt"]);
  });

  test("reads a path between French quotes, with or without a narrow space", () => {
    expect(citedWorkspacePaths("Le fichier « /workspace/notes.md » est prêt.")).toEqual(["notes.md"]);
    expect(citedWorkspacePaths("Le fichier « /workspace/notes.md » est prêt.")).toEqual(["notes.md"]);
    expect(citedWorkspacePaths("Le fichier «/workspace/notes.md» est prêt.")).toEqual(["notes.md"]);
  });

  test("keeps several files in order, once each, capped at five", () => {
    expect(citedWorkspacePaths("/workspace/a.md /workspace/b.md /workspace/a.md")).toEqual(["a.md", "b.md"]);
    const many = Array.from({ length: 9 }, (_, index) => `/workspace/f${index}.md`).join("\n");
    expect(citedWorkspacePaths(many)).toEqual(["f0.md", "f1.md", "f2.md", "f3.md", "f4.md"]);
  });

  test("accepts a relative path below /workspace", () => {
    expect(citedWorkspacePaths("Rangé dans `/workspace/reports/q3.md`.")).toEqual(["reports/q3.md"]);
  });

  test("refuses traversal, paths outside /workspace, globs, directories and hidden or sensitive files", () => {
    for (const reply of [
      "Lis /workspace/../etc/passwd.txt",
      "Lis /workspace/sub/../../x.md",
      "Lis /workspace/./x.md",
      "Le fichier /tmp/notes.md est là.",
      "Le fichier /srv/workspace/notes.md est là.",
      "Le fichier ~/workspace/notes.md est là.",
      "Le fichier file:///workspace/notes.md est là.",
      "Tous les fichiers /workspace/*.md sont là.",
      "Le fichier /workspace/note?.md est là.",
      "Le dossier /workspace/reports/ est prêt.",
      "Le dossier /workspace/reports est prêt.",
      "Le fichier /workspace/.env.txt est là.",
      "Le fichier /workspace/secrets/token.txt est là.",
      "Le fichier /workspace/script.sh est là.",
      "Le fichier /workspace/a%2Fb.md est là.",
    ]) expect(citedWorkspacePaths(reply)).toEqual([]);
  });

  test("ignores a path inside a fenced command block, not one in other fences or around it", () => {
    const reply = [
      "J'ai lancé :",
      "```bash",
      "cat /workspace/log.txt > /workspace/copy.txt",
      "```",
      "```",
      "ls /workspace/other.md",
      "```",
      "Le résultat est dans `/workspace/notes.md`.",
      "```markdown",
      "Voir /workspace/annexe.md",
      "```",
    ].join("\n");
    expect(citedWorkspacePaths(reply)).toEqual(["notes.md", "annexe.md"]);
    expect(citedWorkspacePaths("~~~sh\ncat /workspace/a.md\n~~~\n/workspace/b.md")).toEqual(["b.md"]);
  });

  test("leaves a file named by a MEDIA: line to that delivery", () => {
    expect(citedWorkspacePaths("MEDIA:/workspace/chart.png\nLe graphique `/workspace/chart.png` et /workspace/notes.md.")).toEqual(["notes.md"]);
    expect(citedWorkspacePaths("MEDIA:/workspace/notes.md")).toEqual([]);
  });

  test("returns nothing for a reply with no workspace path", () => {
    expect(citedWorkspacePaths("Bonjour !")).toEqual([]);
    expect(citedWorkspacePaths(null)).toEqual([]);
  });
});

describe("deliverable types and transcript writes", () => {
  test("a markdown file is text/markdown, an unknown extension is not deliverable", () => {
    expect(deliverableType("notes.md")).toEqual({ contentType: "text/markdown", kind: "document" });
    expect(deliverableType("reports/q3.CSV")).toEqual({ contentType: "text/csv", kind: "document" });
    expect(deliverableType("run.sh")).toBeNull();
  });

  test("the last write of the turn to the cited path wins, absolute or relative", () => {
    const write = (path: string, content: string) => ({
      role: "assistant",
      tool_calls: [{ id: path, type: "function", function: { name: "write_file", arguments: JSON.stringify({ path, content }) } }],
    });
    const turn = [write("/workspace/notes.md", "v1"), write("notes.md", "v2"), write("/tmp/notes.md", "other")];
    expect(writtenWorkspaceText(turn, "notes.md")).toBe("v2");
    expect(writtenWorkspaceText(turn, "missing.md")).toBeNull();
  });
});
