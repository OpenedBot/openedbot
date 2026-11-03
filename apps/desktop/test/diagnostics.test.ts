import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  closeDiagnostics,
  openDiagnostics,
  pathOnly,
  recordDiagnostic,
  redact,
  resetDiagnosticsForTests,
} from "../src/main/diagnostics";

let dir: string;
let file: string;

function rows(): Array<{ level: string; source: string; message: string; detail: string | null }> {
  closeDiagnostics();
  // Read-write on purpose: closing the journal removes its -wal and -shm
  // files, and on macOS Bun 1.4.4's node:sqlite cannot read a WAL database
  // opened readOnly without its -shm ("unable to open database file").
  const db = new DatabaseSync(file);
  const result = db.prepare("select level, source, message, detail from events order by id").all() as Array<{
    level: string;
    source: string;
    message: string;
    detail: string | null;
  }>;
  db.close();
  return result;
}

beforeEach(() => {
  resetDiagnosticsForTests();
  dir = mkdtempSync(path.join(tmpdir(), "ohb-diagnostics-"));
  file = path.join(dir, "diagnostics.sqlite");
});

afterEach(() => {
  resetDiagnosticsForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("redact", () => {
  test("drops tokens, queries, e-mails and long opaque strings", () => {
    expect(redact("Authorization: Bearer abc.def-123")).toBe("Authorization: Bearer [redacted]");
    expect(redact("token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl here")).toBe("token [jwt] here");
    expect(redact("GET ohb://auth/callback?code=secret&state=x failed")).toBe("GET ohb://auth/callback?[redacted] failed");
    expect(redact("at https://console.openedbot.app/o/acme#frag")).toBe("at https://console.openedbot.app/o/acme?[redacted]");
    expect(redact("user jane.doe+ohb@example.co.uk signed in")).toBe("user [email] signed in");
    expect(redact(`refresh ${"a1B2_c3-".repeat(6)}`)).toBe("refresh [redacted]");
    expect(redact("x".repeat(5000)).length).toBeLessThanOrEqual(2000);
  });

  test("keeps ordinary text", () => {
    expect(redact("GET /api/bots 401")).toBe("GET /api/bots 401");
  });
});

describe("pathOnly", () => {
  test("keeps origin and path, never the query; a local file by its name", () => {
    expect(pathOnly("https://console.openedbot.app/assets/index-x.js?v=1")).toBe("https://console.openedbot.app/assets/index-x.js");
    expect(pathOnly("file:///Users/jane/app/src/renderer/signin.html?password=off")).toBe("file:signin.html");
  });
});

describe("journal", () => {
  test("keeps what was recorded before opening, then writes straight through", () => {
    recordDiagnostic("warn", "main", "early warning");
    openDiagnostics(file, "openedbot 0.1.0, test");
    recordDiagnostic("error", "http", "GET /api/bots 500", "xhr");
    expect(rows()).toEqual([
      { level: "info", source: "main", message: "launch", detail: "openedbot 0.1.0, test" },
      { level: "warn", source: "main", message: "early warning", detail: null },
      { level: "error", source: "http", message: "GET /api/bots 500", detail: "xhr" },
    ]);
  });

  test("redacts before writing", () => {
    openDiagnostics(file, "test");
    recordDiagnostic("error", "page", "fetch failed with Bearer secret-token", "https://console.openedbot.app/x.js?k=v:3");
    const last = rows().at(-1);
    expect(last?.message).toBe("fetch failed with Bearer [redacted]");
    expect(last?.detail).toBe("https://console.openedbot.app/x.js?[redacted]");
  });

  test("a flood from one source is capped, the other sources still get through", () => {
    openDiagnostics(file, "test");
    for (let i = 0; i < 500; i++) recordDiagnostic("error", "page", `render loop ${i}`);
    recordDiagnostic("error", "http", "GET /api/bots 500");
    const all = rows();
    expect(all.filter((row) => row.source === "page")).toHaveLength(120);
    expect(all.at(-1)?.source).toBe("http");
  });

  test("an unreadable file is moved aside and replaced", () => {
    writeFileSync(file, "this is not a sqlite database, only text long enough to look like a header ".repeat(20));
    openDiagnostics(file, "test");
    recordDiagnostic("info", "main", "after recovery");
    const all = rows();
    expect(all.some((row) => row.message.startsWith("previous diagnostics journal unreadable"))).toBe(true);
    expect(all.at(-1)?.message).toBe("after recovery");
    expect(readdirSync(dir).some((name) => name.startsWith("diagnostics.sqlite.corrupt-"))).toBe(true);
  });
});
