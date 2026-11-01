/** Strict metadata validation. The creation audit is openedbot's signed verdict on a
 * sealed connector export; the browser artifact is an operator-supplied
 * observation. Never manufacture either from openedbot run rows. */
import { createHash } from "node:crypto";
import { verifyVerdictSignature } from "../../modules/runtime-link/src/application/audit-verdict";
const check: (value: unknown, message: string) => asserts value = (value, message) => { if (!value) throw new Error(message); };
const time = (value: string) => { const at = Date.parse(value); check(Number.isFinite(at), "Invalid evidence timestamp"); return at; };
export type ExpectedRun = { id: string; remoteId: string; assistantMessageId: string; events: Array<{ cursor: number; sequence: number; type: string }> };
export type CreationAuditEvent = {
  eventId: string; attemptId: string; phase: string; occurredAt: string; runtimeId: string; profile: string;
  idempotencyKeyHash: string; method: string; path: string; status?: number; remoteId?: string; outcome?: string;
};
/** The response of `POST /api/runtimes/:id/creation-audit/verifications`: the verdict openedbot signed, plus the decrypted events it returns to the caller. */
export type CreationAudit = {
  id: string; runtimeId: string; keyId: string | null; exportSha256: string; receivedAt: string;
  verdict: "valid" | "valid_unanchored" | "invalid"; errorCode: string | null; anchor: string;
  coverage: { startedAt: string; lastWrittenAt: string } | null; writeSeq: number | null; count: number | null; dropped: number | null; tail: string | null;
  findings: Array<{ kind: string; eventId?: string; detail?: string; skewMs?: number }>;
  signature: { keyId: string | null; value: string | null; algorithm: string; ephemeral?: boolean };
  events: CreationAuditEvent[];
};
/** Exactly the fields openedbot signs, in the shape it canonicalises; `signature` and `events` are outside the signed payload. */
export function signedVerdictPayload(audit: CreationAudit): Record<string, unknown> {
  const { id, runtimeId, keyId, exportSha256, receivedAt, verdict, errorCode, anchor, coverage, writeSeq, count, dropped, tail, findings } = audit;
  return { id, runtimeId, keyId, exportSha256, receivedAt, verdict, errorCode, anchor, coverage, writeSeq, count, dropped, tail, findings };
}
/** Offline check with the key published by `GET /api/creation-audit/verdict-key`; binds the verdict to the export bytes when their digest is known. */
export function proveVerdictSignature(audit: CreationAudit, publicKey: string, exportSha256?: string) {
  check(audit.signature?.algorithm === "ed25519" && typeof audit.signature.value === "string" && audit.signature.value.length > 0, "Verdict carries no Ed25519 signature");
  check(verifyVerdictSignature(signedVerdictPayload(audit), audit.signature.value, publicKey), "Verdict signature does not verify with the published key");
  check(!exportSha256 || audit.exportSha256 === exportSha256, "Verdict was issued for a different export");
  return { signatureKeyId: audit.signature.keyId, ephemeral: audit.signature.ephemeral === true };
}
export function proveRemoteCreations(audit: CreationAudit, expected: { runtimeId: string; profile: string; startedAt: string; endedAt: string; runs: ExpectedRun[] }) {
  check(audit.verdict !== "invalid" && audit.errorCode === null, `Audit verdict is not valid (${audit.errorCode ?? audit.verdict})`);
  check(audit.runtimeId === expected.runtimeId && audit.dropped === 0 && audit.coverage !== null && Array.isArray(audit.events) && audit.count === audit.events.length, "Audit identity, dropped-event or count failure");
  check(time(audit.coverage.startedAt) <= time(expected.startedAt) && time(audit.receivedAt) >= time(expected.endedAt), "Audit does not cover the entire scenario");
  check(new Set(audit.events.map((event) => event.eventId)).size === audit.events.length, "Audit event IDs missing or duplicated");
  const events = audit.events.filter((event) => event.profile === expected.profile && time(event.occurredAt) >= time(expected.startedAt) && time(event.occurredAt) <= time(audit.coverage!.lastWrittenAt));
  check(events.length === expected.runs.length * 2, "Unexpected remote creation attempt/outcome in owned profile");
  const attempts = new Set<string>(), remotes = new Set<string>();
  for (const run of expected.runs) {
    const hash = createHash("sha256").update(run.id).digest("hex");
    const own = events.filter((event) => event.idempotencyKeyHash === hash);
    const attempt = own.find((event) => event.phase === "attempt"), outcome = own.find((event) => event.phase === "outcome");
    check(own.length === 2 && attempt && outcome && attempt.attemptId && attempt.attemptId === outcome.attemptId, "Missing or repeated correlated creation");
    check(!attempts.has(attempt.attemptId) && !remotes.has(run.remoteId), "Attempt or remote ID reused across runs");
    attempts.add(attempt.attemptId); remotes.add(run.remoteId);
    check(own.every((event) => event.eventId && event.runtimeId === expected.runtimeId && event.method === "POST" && event.path === "/v1/runs"), "Invalid creation audit provenance");
    check(time(outcome.occurredAt) >= time(attempt.occurredAt) && outcome.outcome === "response" && outcome.status! >= 200 && outcome.status! < 300 && outcome.remoteId === run.remoteId, "Remote creation unresolved, ambiguous or mismatched");
  }
  return { attempts: attempts.size, successfulResponses: remotes.size, verdict: audit.verdict, anchor: audit.anchor, verdictId: audit.id, findings: audit.findings.map((finding) => finding.kind),
    scope: "Every connector-dispatched creation in the owned profile during the scenario, as decrypted and cross-checked by OHB" };
}
export type BrowserEvidence = { schemaVersion: number; source: string; phase: string; nonce: string; threadId: string; apiOrigin: string; eventOrigin: string; pageOrigin: string; pagePath: string; installedAt: string; exportedAt: string; dropped: number;
  requests: Array<{ id: number; at: string; cursor: number; status?: number }>;
  events: Array<{ requestId: number; at: string; runId: string; cursor: number; sequence: number; type: string }>;
  rendered: Array<{ target: string; count: number; nonempty: boolean }>;
  gaps?: Array<{ requestId: number; at: string; from: number; to: number }>;
  errors: string[];
};
export function proveBrowserReplay(browser: BrowserEvidence, expected: { nonce: string; threadId: string; apiOrigin: string; eventOrigin: string; pageOrigin: string; pagePath: string; startedAt: string; endedAt: string; boots: string[]; runs: ExpectedRun[] }) {
  check(browser.schemaVersion === 1 && browser.source === "ghostchrome-mcp-page-fetch" && browser.phase === "complete", "Missing completed Ghostchrome observation");
  check(browser.nonce === expected.nonce && browser.threadId === expected.threadId && browser.apiOrigin === expected.apiOrigin && browser.eventOrigin === expected.eventOrigin && browser.pageOrigin === expected.pageOrigin && browser.pagePath === expected.pagePath, "Browser evidence belongs to a different scenario or origin");
  check(time(browser.installedAt) <= time(expected.startedAt) && time(browser.exportedAt) >= time(expected.endedAt) && browser.dropped === 0, "Browser coverage is incomplete");
  const legacyGaps = browser.errors.filter((error) => error === "Application SSE stream gap").length;
  check(browser.errors.length === legacyGaps, "Browser observer errors other than global stream gaps");
  for (const gap of browser.gaps ?? []) check(Number.isSafeInteger(gap.from) && Number.isSafeInteger(gap.to) && gap.from >= 0 && gap.to > gap.from
    && browser.requests.some((request) => request.id === gap.requestId && time(request.at) <= time(gap.at)), "Invalid global gap metadata");
  check(new Set(browser.requests.map((request) => request.id)).size === browser.requests.length, "Browser request IDs duplicated");
  for (const run of expected.runs) {
    check(run.events.length > 0 && run.events.every((event, index) => event.sequence === index), "Persisted run event coverage must be complete from sequence zero");
    const events = browser.events.filter((event) => event.runId === run.id);
    check(events.length === run.events.length && events.every((event, index) => event.cursor === run.events[index]?.cursor && event.sequence === run.events[index]?.sequence && event.type === run.events[index]?.type), "Browser events differ from persisted run cursors/order");
    check(events.filter((event) => event.type === "run.completed").length === 1, "Browser terminal missing or duplicated");
    check(events.every((event) => browser.requests.some((request) => request.id === event.requestId && request.status === 200 && request.cursor < event.cursor && time(request.at) <= time(event.at))), "Browser event has no matching actual stream request");
    const rendered = browser.rendered.filter((node) => node.target === `message:${run.assistantMessageId}`);
    check(rendered.length === 1 && rendered[0]!.count === 1 && rendered[0]!.nonempty, "Assistant response is absent, empty or duplicated in rendered page");
  }
  for (const [index, boot] of expected.boots.entries()) {
    const nextBoot = expected.boots[index + 1];
    const at = time(boot), beforeRequest = browser.requests.filter((request) => time(request.at) < at && request.status === 200).at(-1);
    check(beforeRequest, "No browser stream request observed before API restart");
    const beforeEvents = browser.events.filter((event) => time(event.at) < at);
    const priorCursor = Math.max(beforeRequest.cursor, ...beforeEvents.map((event) => event.cursor));
    const resumed = browser.requests.find((request) => time(request.at) >= at && (!nextBoot || time(request.at) < time(nextBoot)) && request.status === 200 && request.cursor >= priorCursor);
    check(resumed, "Browser did not resume from its cursor after API restart");
  }
  return { scope: "Complete persisted event sequences and rendered responses for the expected runs", globalGaps: browser.gaps ?? [], legacyGlobalGapsWithoutRanges: legacyGaps, gapAssessment: (legacyGaps || browser.gaps?.length) ? "Observed global gaps caused no missing expected-run event; global history outside these runs is not certified" : "No observed global gaps", source: browser.source, apiRestarts: expected.boots.length, matchedRuns: expected.runs.length, matchedEvents: browser.events.filter((event) => expected.runs.some((run) => run.id === event.runId)).length };
}
