import { expect, test } from "bun:test";
import { installContinuityObserver } from "../../../tests/e2e/runtime-link-browser-observer";
import { createHash } from "node:crypto";
import { proveRemoteCreations, proveBrowserReplay, proveVerdictSignature, signedVerdictPayload, type CreationAudit, type BrowserEvidence, type ExpectedRun } from "../../../tests/e2e/runtime-link-external-proof";
import { createVerdictSigner } from "@openedbot/runtime-link/application/audit-verdict";
const at = (second: number) => new Date(Date.UTC(2026, 8, 5, 12, 0, second)).toISOString();
const runs: ExpectedRun[] = [
  { id: "run-one", remoteId: "remote-one", assistantMessageId: "message-one", events: [{ cursor: 1, sequence: 0, type: "run.started" }, { cursor: 2, sequence: 1, type: "run.delta" }, { cursor: 3, sequence: 2, type: "run.completed" }] },
  { id: "run-two", remoteId: "remote-two", assistantMessageId: "message-two", events: [{ cursor: 4, sequence: 0, type: "run.completed" }] },
];
const expected = { runtimeId: "runtime", profile: "owned-profile", startedAt: at(0), endedAt: at(8), runs };
/** openedbot's verdict on the sealed export, as `POST …/creation-audit/verifications` returns it. */
function audit(): CreationAudit {
  const events = runs.flatMap((run, index) => ["attempt", "outcome"].map((phase, phaseIndex) => ({
    eventId: `${run.id}-${phase}`, attemptId: `${run.id}-attempt`, phase, occurredAt: at(1 + index * 5 + phaseIndex), runtimeId: expected.runtimeId,
    profile: expected.profile, correlationId: createHash("sha256").update(run.id).digest("hex"), idempotencyKeyHash: createHash("sha256").update(run.id).digest("hex"), method: "POST", path: "/v1/runs",
    ...(phase === "outcome" ? { status: 200, remoteId: run.remoteId, outcome: "response" } : {}),
  })));
  return { id: "verdict-1", runtimeId: expected.runtimeId, keyId: "k-1", exportSha256: "ab".repeat(32), receivedAt: at(9), verdict: "valid", errorCode: null, anchor: "matches",
    coverage: { startedAt: at(-1), lastWrittenAt: at(7) }, writeSeq: 4, count: events.length, dropped: 0, tail: "cd".repeat(32), findings: [],
    signature: { keyId: "sig", value: "", algorithm: "ed25519" }, events };
}
test("remote audit requires a valid verdict, complete coverage and exactly one resolved dispatch per primary run", () => {
  expect(proveRemoteCreations(audit(), expected)).toMatchObject({ attempts: 2, verdict: "valid", anchor: "matches" });
  expect(() => proveRemoteCreations({ ...audit(), verdict: "invalid", errorCode: "AUDIT_CHAIN_BROKEN" }, expected)).toThrow("AUDIT_CHAIN_BROKEN");
  expect(() => proveRemoteCreations({ ...audit(), dropped: 1 }, expected)).toThrow("dropped");
  expect(() => proveRemoteCreations({ ...audit(), receivedAt: at(7) }, expected)).toThrow("cover");
  expect(() => proveRemoteCreations({ ...audit(), coverage: { startedAt: at(1), lastWrittenAt: at(7) } }, expected)).toThrow("cover");
  const orphan = audit(); orphan.events.push({ ...orphan.events[0]!, eventId: "orphan", attemptId: "orphan" }); orphan.count = orphan.events.length;
  expect(() => proveRemoteCreations(orphan, expected)).toThrow("Unexpected");
  expect(() => proveRemoteCreations({ ...orphan, count: 4 }, expected)).toThrow("count");
  const ambiguous = audit(); ambiguous.events[1]!.outcome = "ambiguous";
  expect(() => proveRemoteCreations(ambiguous, expected)).toThrow("ambiguous");
  const wrong = audit(); wrong.events[1]!.remoteId = "other-remote";
  expect(() => proveRemoteCreations(wrong, expected)).toThrow("mismatched");
  const missing = audit(); missing.events.pop(); missing.count = missing.events.length;
  expect(() => proveRemoteCreations(missing, expected)).toThrow("Unexpected");
});
const browserExpected = { ...expected, nonce: "fresh-nonce", threadId: "thread", apiOrigin: "https://api.example.test", pageOrigin: "https://app.example.test", eventOrigin: "https://app.example.test", pagePath: "/bot/owned-bot", boots: [at(2), at(4)] };
function browser(): BrowserEvidence {
  return { schemaVersion: 1, source: "ghostchrome-mcp-page-fetch", phase: "complete", ...browserExpected, installedAt: at(-1), exportedAt: at(9), dropped: 0,
    requests: [{ id: 1, at: at(0), cursor: 0, status: 200 }, { id: 2, at: at(2), cursor: 1, status: 200 }, { id: 3, at: at(4), cursor: 2, status: 200 }],
    events: runs.flatMap((run) => run.events.map((event) => ({ ...event, runId: run.id, requestId: Math.min(event.cursor, 3), at: at(event.cursor * 2 - 1) }))),
    rendered: runs.map((run) => ({ target: `message:${run.assistantMessageId}`, count: 1, nonempty: true })), errors: [] };
}
test("browser proof binds actual resumed requests, ordered persisted cursors and unique rendered messages", () => {
  expect(proveBrowserReplay(browser(), browserExpected).matchedRuns).toBe(2);
  expect(() => proveBrowserReplay({ ...browser(), eventOrigin: "https://other.example.test" }, browserExpected)).toThrow("different");
  expect(() => proveBrowserReplay({ ...browser(), pagePath: "/bot/other" }, browserExpected)).toThrow("different");
  expect(() => proveBrowserReplay({ ...browser(), nonce: "old-nonce" }, browserExpected)).toThrow("different");
  expect(() => proveBrowserReplay({ ...browser(), errors: ["stream gap"] }, browserExpected)).toThrow("errors");
  const duplicate = browser(); duplicate.events.push(duplicate.events[0]!);
  expect(() => proveBrowserReplay(duplicate, browserExpected)).toThrow("cursors/order");
  const wrongCursor = browser(); wrongCursor.events[1]!.cursor = 50;
  expect(() => proveBrowserReplay(wrongCursor, browserExpected)).toThrow("cursors/order");
  const noReplay = browser(); noReplay.requests[1]!.cursor = 0;
  expect(() => proveBrowserReplay(noReplay, browserExpected)).toThrow("resume");
  const duplicateUI = browser(); duplicateUI.rendered[0]!.count = 2;
  expect(() => proveBrowserReplay(duplicateUI, browserExpected)).toThrow("duplicated");
  expect(() => proveBrowserReplay({ ...browser(), exportedAt: at(7) }, browserExpected)).toThrow("coverage");
});

test("observer passes actual consumed SSE bytes through and captures metadata on PWA proxy origin", async () => {
  const priorFetch = globalThis.fetch, priorLocation = Object.getOwnPropertyDescriptor(globalThis, "location"), priorDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const host = globalThis as typeof globalThis & { __ohbContinuityEvidence?: { snapshot(stop?: boolean): unknown } };
  const observer = (): { snapshot(stop?: boolean): unknown } | undefined => host.__ohbContinuityEvidence;
  const priorObserver = host.__ohbContinuityEvidence;
  delete host.__ohbContinuityEvidence;
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "http://localhost:1420", href: "http://localhost:1420/bot/test", pathname: "/bot/test" } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelectorAll: () => [] } });
  const raw = 'id: 7\nevent: run.completed\ndata: {"threadId":"thread","runId":"run","cursor":7,"sequence":1,"type":"run.completed","payload":{"text":"private"}}\n\n';
  let calls = 0;
  globalThis.fetch = Object.assign(async () => { calls++; return new Response(raw); }, { preconnect: priorFetch.preconnect });
  try {
    installContinuityObserver({ nonce: "nonce", threadId: "thread", apiOrigin: "http://127.0.0.1:8790", pageOrigin: "http://localhost:1420", observationSeconds: 10 });
    expect(await (await fetch("http://localhost:1420/api/events?cursor=6")).text()).toBe(raw);
    const evidence = observer()!.snapshot(true) as BrowserEvidence;
    expect(calls).toBe(1);
    expect(evidence.events.map(({ cursor }) => cursor)).toEqual([7]);
    expect(JSON.stringify(evidence)).not.toContain("private");
  } finally {
    observer()?.snapshot(true); globalThis.fetch = priorFetch;
    if (priorObserver) host.__ohbContinuityEvidence = priorObserver; else delete host.__ohbContinuityEvidence;
    if (priorLocation) Object.defineProperty(globalThis, "location", priorLocation); else Reflect.deleteProperty(globalThis, "location");
    if (priorDocument) Object.defineProperty(globalThis, "document", priorDocument); else Reflect.deleteProperty(globalThis, "document");
  }
});

test("global deletion holes preserve scoped proof only with exhaustive expected-run coverage", () => {
  const observed = browser();
  observed.gaps = [{ requestId: 2, at: at(2), from: 0, to: 1 }];
  expect(proveBrowserReplay(observed, browserExpected).globalGaps).toHaveLength(1);
  const legacy = browser(); legacy.errors = ["Application SSE stream gap"];
  expect(proveBrowserReplay(legacy, browserExpected).legacyGlobalGapsWithoutRanges).toBe(1);
  const missing = browser(); missing.errors = ["Application SSE stream gap"]; missing.events.splice(1, 1);
  expect(() => proveBrowserReplay(missing, browserExpected)).toThrow("cursors/order");
  const incomplete = structuredClone(browserExpected); incomplete.runs[0]!.events.splice(1, 1);
  expect(() => proveBrowserReplay(observed, incomplete)).toThrow("coverage");
});

test("a successful browser stream can predate the first boot without having received a run event", () => {
  const observed = browser(); observed.events[0]!.at = at(3); observed.events[0]!.requestId = 2; observed.requests[1]!.cursor = 0;
  expect(proveBrowserReplay(observed, browserExpected).apiRestarts).toBe(2);
  observed.requests.shift();
  expect(() => proveBrowserReplay(observed, browserExpected)).toThrow("before API restart");
});

test("verdict signature verifies only with the publishing key, over the signed fields, for the same export", () => {
  const signer = createVerdictSigner({ seed: new Uint8Array(Buffer.alloc(32, 9)), ephemeral: false });
  const signed = { ...audit(), signature: { ...signer.sign(signedVerdictPayload(audit())), algorithm: "ed25519" } };
  const artifact: CreationAudit = { ...signed, signature: { keyId: signed.signature.signatureKeyId, value: signed.signature.signature, algorithm: "ed25519" } };
  expect(proveVerdictSignature(artifact, signer.publicKey, artifact.exportSha256)).toEqual({ signatureKeyId: signer.keyId, ephemeral: false });
  expect(() => proveVerdictSignature({ ...artifact, verdict: "valid_unanchored" }, signer.publicKey)).toThrow("signature");
  expect(() => proveVerdictSignature(artifact, createVerdictSigner({ seed: new Uint8Array(Buffer.alloc(32, 8)), ephemeral: true }).publicKey)).toThrow("signature");
  expect(() => proveVerdictSignature(artifact, signer.publicKey, "00".repeat(32))).toThrow("different export");
  expect(() => proveVerdictSignature({ ...artifact, signature: { keyId: null, value: null, algorithm: "ed25519" } }, signer.publicKey)).toThrow("no Ed25519");
});
