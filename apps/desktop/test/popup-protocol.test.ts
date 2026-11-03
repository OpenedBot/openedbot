import { describe, expect, test } from "bun:test";
import {
  encodeHostMessage,
  encodePopupMessage,
  LineSplitter,
  MAX_LINE_LENGTH,
  parseHostMessage,
  parsePopupMessage,
  POPUP_PROTOCOL_VERSION,
  RequestLedger,
  resolveConsolePath,
  type HostToPopup,
  type PopupToHost,
} from "../src/shared/popup-protocol";

describe("popup -> host messages", () => {
  test("valid lines parse to their message", () => {
    expect(parsePopupMessage('{"type":"ready","protocol":1,"version":"0.1.0"}')).toEqual({
      ok: true,
      message: { type: "ready", protocol: 1, version: "0.1.0" },
    });
    expect(parsePopupMessage('{"type":"token","id":"7","force":true}')).toEqual({
      ok: true,
      message: { type: "token", id: "7", force: true },
    });
    expect(parsePopupMessage('{"type":"openConsole","path":"/bot/b1"}')).toEqual({
      ok: true,
      message: { type: "openConsole", path: "/bot/b1" },
    });
    expect(parsePopupMessage('{"type":"signOut"}')).toEqual({ ok: true, message: { type: "signOut" } });
    expect(parsePopupMessage('{"type":"fatal","code":"STANDALONE_RUNNING"}')).toEqual({
      ok: true,
      message: { type: "fatal", code: "STANDALONE_RUNNING" },
    });
  });

  test("force defaults to false and unknown fields are ignored", () => {
    expect(parsePopupMessage('{"type":"token","id":"1","extra":{"a":1}}')).toEqual({
      ok: true,
      message: { type: "token", id: "1", force: false },
    });
  });

  test("malformed lines are refused with a reason, never thrown", () => {
    expect(parsePopupMessage("not json")).toEqual({ ok: false, reason: "invalid-json" });
    expect(parsePopupMessage('{"type":"token"')).toEqual({ ok: false, reason: "invalid-json" });
    expect(parsePopupMessage("[1,2]")).toEqual({ ok: false, reason: "not-an-object" });
    expect(parsePopupMessage("null")).toEqual({ ok: false, reason: "not-an-object" });
    expect(parsePopupMessage('"ready"')).toEqual({ ok: false, reason: "not-an-object" });
    expect(parsePopupMessage('{"type":"launchMissiles"}')).toEqual({ ok: false, reason: "unknown-type" });
    expect(parsePopupMessage("{}")).toEqual({ ok: false, reason: "unknown-type" });
  });

  test("fields of the wrong shape are refused", () => {
    const refused = [
      '{"type":"ready","protocol":"1","version":"0.1.0"}',
      '{"type":"ready","protocol":1.5,"version":"0.1.0"}',
      '{"type":"ready","protocol":1}',
      '{"type":"token","id":7}',
      '{"type":"token","id":""}',
      '{"type":"token","id":"a b"}',
      `{"type":"token","id":"${"x".repeat(65)}"}`,
      '{"type":"token","id":"1","force":"yes"}',
      '{"type":"openConsole"}',
      '{"type":"openConsole","path":""}',
      '{"type":"fatal","code":"lower"}',
    ];
    for (const line of refused) expect(parsePopupMessage(line)).toEqual({ ok: false, reason: "invalid-fields" });
  });

  test("an unknown protocol version still parses: the host decides to stop", () => {
    const parsed = parsePopupMessage('{"type":"ready","protocol":2,"version":"9.0.0"}');
    expect(parsed.ok && parsed.message.type === "ready" && parsed.message.protocol).toBe(2);
    expect(POPUP_PROTOCOL_VERSION).toBe(1);
  });

  test("an overlong line is refused before JSON parsing", () => {
    const long = `{"type":"openConsole","path":"/${"a".repeat(MAX_LINE_LENGTH)}"}`;
    expect(parsePopupMessage(long)).toEqual({ ok: false, reason: "too-long" });
  });

  test("encode then parse round-trips every popup message", () => {
    const messages: PopupToHost[] = [
      { type: "ready", protocol: 1, version: "0.1.0" },
      { type: "token", id: "12", force: false },
      { type: "openConsole", path: "/inbox?kind=approval" },
      { type: "signOut" },
      { type: "fatal", code: "BAD_HELLO" },
    ];
    for (const message of messages) {
      const encoded = encodePopupMessage(message);
      expect(encoded.endsWith("\n")).toBe(true);
      expect(encoded.slice(0, -1).includes("\n")).toBe(false);
      expect(parsePopupMessage(encoded.trimEnd())).toEqual({ ok: true, message });
    }
  });
});

describe("host -> popup messages", () => {
  const signedInReply = {
    type: "token",
    id: "3",
    accessToken: "at-123",
    expiresAt: "2026-10-12T10:15:00.000Z",
    organizationId: "org-1",
  } as const;

  test("token replies: granted, signed out, unavailable", () => {
    expect(parseHostMessage(JSON.stringify(signedInReply))).toEqual({ ok: true, message: signedInReply });
    const out = { type: "token", id: "4", accessToken: null, expiresAt: null, organizationId: null };
    expect(parseHostMessage(JSON.stringify(out))).toEqual({ ok: true, message: out });
    const down = { ...out, error: "unavailable" };
    expect(parseHostMessage(JSON.stringify(down))).toEqual({ ok: true, message: down });
  });

  test("a half-null token reply, or an error carrying a token, is refused", () => {
    expect(parseHostMessage(JSON.stringify({ ...signedInReply, organizationId: null })).ok).toBe(false);
    expect(parseHostMessage(JSON.stringify({ ...signedInReply, error: "unavailable" })).ok).toBe(false);
    expect(parseHostMessage(JSON.stringify({ ...signedInReply, error: "other" })).ok).toBe(false);
  });

  test("hello, signedIn, signedOut", () => {
    const hello = { type: "hello", protocol: 1, apiOrigin: "https://api.openedbot.app", consoleUrl: "https://console.openedbot.app" };
    expect(parseHostMessage(JSON.stringify(hello))).toEqual({ ok: true, message: hello });
    expect(parseHostMessage('{"type":"signedIn"}')).toEqual({ ok: true, message: { type: "signedIn" } });
    expect(parseHostMessage('{"type":"signedOut"}')).toEqual({ ok: true, message: { type: "signedOut" } });
    expect(parseHostMessage('{"type":"hello","protocol":1}')).toEqual({ ok: false, reason: "invalid-fields" });
  });

  test("the serializer keeps only protocol fields: a refresh token cannot leak", () => {
    const record = { ...signedInReply, refreshToken: "rt-secret", accessTokenExpiresAt: "x" };
    const encoded = encodeHostMessage(record as HostToPopup);
    expect(encoded).not.toContain("rt-secret");
    expect(encoded).not.toContain("refreshToken");
    expect(JSON.parse(encoded)).toEqual(signedInReply);
  });

  test("encode then parse round-trips every host message", () => {
    const messages: HostToPopup[] = [
      { type: "hello", protocol: 1, apiOrigin: "http://localhost:1420", consoleUrl: "http://localhost:1420" },
      signedInReply,
      { type: "token", id: "9", accessToken: null, expiresAt: null, organizationId: null, error: "unavailable" },
      { type: "signedOut" },
      { type: "signedIn" },
    ];
    for (const message of messages) expect(parseHostMessage(encodeHostMessage(message).trimEnd())).toEqual({ ok: true, message });
  });

  test("an embedded newline stays escaped on one line", () => {
    const encoded = encodePopupMessage({ type: "openConsole", path: "/a\nb" });
    expect(encoded.split("\n").length).toBe(2);
  });
});

describe("request ledger", () => {
  test("a duplicate id is refused while the first is in flight, accepted once settled", () => {
    const ledger = new RequestLedger();
    expect(ledger.begin("1")).toBe(true);
    expect(ledger.begin("1")).toBe(false);
    expect(ledger.settle("1")).toBe(true);
    expect(ledger.begin("1")).toBe(true);
  });

  test("a reply without a request is reported", () => {
    const ledger = new RequestLedger();
    expect(ledger.settle("42")).toBe(false);
    ledger.begin("1");
    ledger.begin("2");
    // Out of order is fine: ids, not positions, match replies.
    expect(ledger.settle("2")).toBe(true);
    expect(ledger.settle("2")).toBe(false);
    expect(ledger.settle("1")).toBe(true);
    expect(ledger.size).toBe(0);
  });
});

describe("line splitter", () => {
  test("joins chunks, splits lines, drops blank lines and CR", () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"type":"sig')).toEqual({ lines: [], overflowed: 0 });
    expect(splitter.push('nOut"}\r\n\n{"type":"ready"')).toEqual({ lines: ['{"type":"signOut"}'], overflowed: 0 });
    expect(splitter.push(',"protocol":1,"version":"1"}\n')).toEqual({
      lines: ['{"type":"ready","protocol":1,"version":"1"}'],
      overflowed: 0,
    });
  });

  test("an overlong line is dropped up to its newline without buffering it", () => {
    const splitter = new LineSplitter(10);
    expect(splitter.push("0123456789ABC")).toEqual({ lines: [], overflowed: 1 });
    expect(splitter.push("still the same line")).toEqual({ lines: [], overflowed: 0 });
    expect(splitter.push(" end\nok\n")).toEqual({ lines: ["ok"], overflowed: 0 });
    expect(splitter.push("0123456789ABC\nnext\n")).toEqual({ lines: ["next"], overflowed: 1 });
  });
});

describe("console paths", () => {
  const consoleUrl = "https://console.openedbot.app";

  test("plain absolute paths resolve on the console", () => {
    expect(resolveConsolePath(consoleUrl, "/")).toBe("https://console.openedbot.app/");
    expect(resolveConsolePath(consoleUrl, "/bot/0b6c")).toBe("https://console.openedbot.app/bot/0b6c");
    expect(resolveConsolePath(consoleUrl, "/inbox?kind=approval")).toBe("https://console.openedbot.app/inbox?kind=approval");
  });

  test("anything that could leave the console is refused", () => {
    for (const path of ["", "bot/1", "//evil.example/x", "/\\evil.example", "https://evil.example/", "/a\u0000b", "/a\nb"]) {
      expect(resolveConsolePath(consoleUrl, path)).toBeNull();
    }
    expect(resolveConsolePath(consoleUrl, `/${"a".repeat(1100)}`)).toBeNull();
  });

  test("a console mounted under a prefix keeps it, even against ..", () => {
    expect(resolveConsolePath("https://lab.example/console", "/bot/1")).toBe("https://lab.example/console/bot/1");
    expect(resolveConsolePath("https://lab.example/console", "/../admin")).toBeNull();
  });
});
