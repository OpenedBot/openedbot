import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isSensitivePath, PROTECTED_PATH_PATTERNS } from "@openedbot/roster/domain/editor-directives";
import {
  denyPathMatches,
  YOLO_DEFAULT_PROTECT,
  YOLO_HARDLINE,
  YOLO_PROTECTIONS,
  yoloDenyListHit,
  yoloHardlineHit,
  yoloProtectionHit,
  type YoloGateSubject,
} from "../src/domain/yolo-hardline";

// Twin of edge-setup `test/golden/yolo-hardline/hardline.json`: the host's Go
// auto-responder and Python plugin read the same file, and `make
// contract-check` compares both copies byte for byte.
type Fixture = {
  hardline: typeof YOLO_HARDLINE;
  protect: Record<string, { paths: string[]; commands: string[] }>;
  defaultProtect: string[];
  cases: Array<{ kind: "command" | "path" | "tool"; input: string; expect: string }>;
};
const fixture = JSON.parse(readFileSync(new URL("./fixtures/yolo-hardline.json", import.meta.url), "utf8")) as Fixture;

const subjectOf = (entry: Fixture["cases"][number]): YoloGateSubject => ({
  toolKey: entry.kind === "tool" ? entry.input : null,
  paths: entry.kind === "path" ? [entry.input] : [],
  command: entry.kind === "command" ? entry.input : null,
});
const none = { commands: [], tools: [], paths: [] };

describe("YOLO hardline and protections follow the shared fixture", () => {
  test("the rules are the fixture's, in the same order", () => {
    expect(fixture.hardline).toEqual(JSON.parse(JSON.stringify(YOLO_HARDLINE)));
    expect(fixture.protect).toEqual(JSON.parse(JSON.stringify(YOLO_PROTECTIONS)));
    expect(fixture.defaultProtect).toEqual([...YOLO_DEFAULT_PROTECT]);
  });

  test("each protection's path is the circuit breaker's own pattern, keychain included", () => {
    for (const [id, pattern] of Object.entries(PROTECTED_PATH_PATTERNS)) {
      expect({ id, sources: fixture.protect[id]?.paths.map((source) => new RegExp(source).source) }).toEqual({ id, sources: [pattern.source] });
    }
    expect(Object.keys(fixture.protect).sort()).toEqual(Object.keys(PROTECTED_PATH_PATTERNS).sort());
  });

  test("the fixture is non-trivial", () => {
    expect(fixture.cases.length).toBeGreaterThan(40);
    for (const verdict of ["hardline:", "protected:", "allowed"]) expect(fixture.cases.some((entry) => entry.expect.startsWith(verdict))).toBe(true);
  });

  for (const entry of fixture.cases) {
    test(`${entry.kind} ${JSON.stringify(entry.input)} -> ${entry.expect}`, () => {
      const subject = subjectOf(entry);
      const hard = yoloHardlineHit(subject);
      const verdict = hard ? `hardline:${hard}` : (() => {
        const id = yoloProtectionHit(subject, YOLO_DEFAULT_PROTECT);
        return id ? `protected:${id}` : "allowed";
      })();
      expect(verdict).toBe(entry.expect);
    });
  }
});

describe("YOLO protections and deny-list", () => {
  test("the default protections hold even when a lease lists fewer", () => {
    expect(yoloProtectionHit({ toolKey: "write_file", paths: ["/Users/me/Library/Keychains/x"], command: null }, ["ssh"])).toBe("keychain");
  });

  test("the keychain is now a sensitive path for the floor too", () => {
    expect(isSensitivePath("/Users/me/Library/Keychains/login.keychain-db")).toBe(true);
    expect(isSensitivePath("/Users/me/Library/Caches/x")).toBe(false);
  });

  test.each([
    ["/srv/data/x", "/srv/data", true],
    ["/srv/data", "/srv/data/", true],
    ["/srv/database", "/srv/data", false],
    ["/home/me/.aws/config", ".aws", true],
    ["my.aws.txt", ".aws", false],
    ["a/b/c.txt", "b/c.txt", true],
    ["a/bb/c.txt", "b/c.txt", false],
    ["/etc/passwd", "/", true],
    ["notes.md", "", false],
  ] as const)("deny path %s against %s -> %s", (path, entry, expected) => {
    expect(denyPathMatches(path, entry)).toBe(expected);
  });

  test("a deny-list hit by tool, path or command; an unreadable command under a command list", () => {
    const deny = { commands: ["git push --force"], tools: ["send_message"], paths: [".aws"] };
    expect(yoloDenyListHit({ toolKey: "send_message", paths: [], command: null }, deny)).toBe(true);
    expect(yoloDenyListHit({ toolKey: "write_file", paths: ["~/.aws/credentials"], command: null }, deny)).toBe(true);
    expect(yoloDenyListHit({ toolKey: null, paths: [], command: "cd x && git push --force origin" }, deny)).toBe(true);
    expect(yoloDenyListHit({ toolKey: null, paths: [], command: "echo 'open" }, deny)).toBeNull();
    expect(yoloDenyListHit({ toolKey: null, paths: [], command: "git push origin" }, deny)).toBe(false);
    expect(yoloDenyListHit({ toolKey: null, paths: [], command: "echo 'open" }, none)).toBe(false);
  });
});
