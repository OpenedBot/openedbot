import { expect, test } from "bun:test";
import { collectHermesProfiles, parseHermesProfileFiles } from "../src/domain/hermes-profile-bundle";
const bytes = (text: string) => new TextEncoder().encode(text);

test("keeps only bounded projections and explicit false capabilities, never credentials or skill contents", () => {
  const result = collectHermesProfiles({ archiveName: "scout.zip", entries: [
    { path: "config.yaml", bytes: bytes("model:\n  default: test/model\n  api_key: SECRET\nplatform_toolsets:\n  api_server:\n    memory: false\nmcp_servers:\n  search:\n    enabled: false\n    command: SECRET\n") },
    { path: ".env", bytes: bytes("SECRET") }, { path: "sessions/a.json", bytes: bytes("SECRET") },
    { path: "skills/research/SKILL.md", bytes: bytes("SECRET") }, { path: "../../config.yaml", bytes: bytes("bad") },
  ] });
  expect(result.candidates).toHaveLength(1);
  const projection = parseHermesProfileFiles("scout", result.candidates[0]!.files);
  expect("entry" in projection).toBe(true);
  expect(JSON.stringify(projection)).not.toContain("SECRET");
  if ("entry" in projection) {
    expect(projection.entry.toolsets).toEqual([{ name: "memory", enabled: false }]);
    expect(projection.entry.mcpServers).toEqual([{ name: "search", enabled: false }]);
    expect(projection.entry.skills).toEqual([{ name: "research", enabled: true }]);
  }
  expect(result.dropped.map((item) => item.reason)).toEqual(["secret", "runtime-data", "path-invalid"]);
});
test("excludes every duplicate slug, home/default profiles and links", () => {
  const result = collectHermesProfiles({ archiveName: "home.zip", entries: [".hermes/config.yaml", ".hermes/profiles/default/config.yaml", "a/scout/config.yaml", "b/scout/config.yaml"].map((path) => ({ path, bytes: bytes("{}") })).concat([{ path: "link/config.yaml", bytes: bytes("{}"), type: "symlink" } as any]) });
  expect(result.candidates).toHaveLength(0);
  expect(result.issues.map((item) => item.code)).toEqual(["default-profile", "default-profile", "slug-duplicate"]);
  expect(result.dropped[0]?.reason).toBe("symlink");
});
test("rejects deep YAML, duplicate keys, excessive aliases and oversized soul without truncation", () => {
  for (const yaml of ["x: 1\nx: 2", "x: " + "[".repeat(60) + "1" + "]".repeat(60), "a: &a [1]\nb: [" + Array(51).fill("*a").join(",") + "]"]) {
    expect(parseHermesProfileFiles("scout", { "config.yaml": bytes(yaml) })).toHaveProperty("issue.code", "config-invalid");
  }
  expect(parseHermesProfileFiles("scout", { "config.yaml": bytes("{}"), "SOUL.md": bytes("a".repeat(8001)) })).toHaveProperty("issue.code", "soul-too-long");
});
test("typed schedules survive projection and an explicit empty API toolset list overrides fallback", () => {
  const parsed = parseHermesProfileFiles("scout", { "config.yaml": bytes("platform_toolsets:\n  api_server: []\ntoolsets: [memory]"), "cron/jobs.json": bytes(JSON.stringify({ jobs: [{ name: "poll", prompt: "Ping", schedule: { kind: "interval", minutes: 30 } }, { name: "one", schedule: { kind: "once", run_at: "2027-01-01" } }] })) });
  if (!("entry" in parsed)) throw new Error("projection rejected");
  expect(parsed.entry.toolsets).toEqual([]);
  expect(parsed.entry.routines.map((routine) => routine.schedule)).toEqual(["every 30m", "once"]);
});
