import { expect, test } from "bun:test";
import { exportMessageMarkdown } from "../src/domain/conversation-export";

test("exports visible text and file references, excludes tool arguments and reasoning", () => {
  const markdown = exportMessageMarkdown({
    role: "assistant",
    author: "Bot\n# forgé",
    createdAt: "2026-11-12T12:00:00Z",
    content: [
      { type: "text", text: "Résumé français — terminé" },
      { type: "reasoning", text: "internal reasoning" },
      {
        type: "tool-call",
        toolCallId: "t",
        toolName: "connect",
        args: { apiKey: "secret-test-token" },
      },
      {
        type: "attachment",
        id: "file-id",
        name: "rapport.pdf",
        contentType: "application/pdf",
        kind: "document",
        bytes: 20,
      },
    ],
  });
  expect(markdown).toContain("Résumé français");
  expect(markdown).toContain("file-id");
  expect(markdown).not.toContain("secret-test-token");
  expect(markdown).not.toContain("internal reasoning");
  expect(markdown).not.toContain("\n# forgé");
});
