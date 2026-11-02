/**
 * Fake host agent — the CLIENT side of the connector link wire contract
 * (`docs/CONNECTOR.md` in edge-setup, mirrored by
 * `contracts/connector/src/relay-frames.ts`). It plays the role of
 * `hermes-connector` on a customer host, against `tests/fake-hermes/server.ts`
 * as the local gateway:
 *
 *   - dials `wss://<ohb>/api/runtime-links/ws` with an enrollment ticket or a
 *     link token, sends `hello` first;
 *   - serves `req` frames by forwarding them to the local gateway with the
 *     LOCAL bearer (the bearer never crosses the wire);
 *   - keeps a per-run journal fed by its own upstream events subscription and
 *     replays `GET /v1/runs/{id}/events?since=<n>` from it, `id:` per frame;
 *   - relays `/v1/capabilities` with `features.event_replay: true`;
 *   - YOLO mode (announce `yolo_lease` in `features`): records the
 *     `yolo.lease` / `yolo.revoke` / `yolo.audit.ack` frames and the
 *     `link.context.leaseKeys` it receives, and emits `yolo.state` and a
 *     hash-chained `yolo.audit` (genesis per runtime, as edge-setup does).
 *     It verifies no signature: the real host does (`yolo_lease.go`).
 *
 * Test double only: bodies are buffered (bounded), not streamed, and the
 * journal lives in memory.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  decodeBinaryFrame,
  decodeTextFrame,
  encodeBinaryFrame,
  encodeTextFrame,
  matchRelayRoute,
  RELAY_FORWARDED_REQUEST_HEADERS,
  RELAY_FORWARDED_RESPONSE_HEADERS,
  RELAY_MAX_REQUEST_BODY,
  RELAY_MAX_RESPONSE_BODY,
  type RelayDiagnosticFrame,
  type RelayTextFrame,
  type RelayYoloAuditEntry,
  type RelayYoloAuditFrame,
  type RelayYoloLeaseState,
  type YoloLeaseKey,
} from "@openedbot/contracts-connector";

/** What openedbot pushed about YOLO leases, in arrival order. */
export type HostAgentYoloFrame = Extract<RelayTextFrame, { t: "yolo.lease" | "yolo.revoke" | "yolo.audit.ack" }>;

/** One auto-approval to journal: the arguments' hash only, as the real host. */
export type HostAgentYoloRecord = {
  leaseId: string;
  profile: string;
  gateKind: "plugin_tool" | "terminal_danger";
  toolKey: string | null;
  /** Hashed here: the frame never carries the arguments. */
  args: string;
  occurredAt?: number;
};

export type HostAgentAuth =
  | { kind: "enrollment"; ticket: string }
  | { kind: "link"; runtimeId: string; linkToken: string };

export type HostAgentOptions = {
  /** ws(s)://…/api/runtime-links/ws */
  wsUrl: string;
  auth: HostAgentAuth;
  /** Local fake gateway base URL (http://127.0.0.1:…). */
  gatewayUrl: string;
  /** Local bearer, added by the host — never received from the wire. */
  gatewayToken: string;
  agent?: string;
  /** `hello.features`, e.g. `yolo_lease` and `yolo_thread_scope` for YOLO mode. */
  features?: string[];
  log?: (event: string, fields: Record<string, unknown>) => void;
};

type JournalEntry = { seq: number; block: string };
type Journal = { entries: JournalEntry[]; terminal: boolean };

const SUBPROTOCOL = "hermes-connector.v1";

export class FakeHostAgent {
  private ws: WebSocket | null = null;
  private readonly journal = new Map<string, Journal>();
  private readonly tails = new Set<string>();
  private readonly requestBodies = new Map<number, Uint8Array[]>();
  private readonly inFlight = new Map<number, AbortController>();
  private issued: { runtimeId: string; linkToken: string } | null = null;
  private issuedWaiters: Array<(issued: { runtimeId: string; linkToken: string }) => void> = [];
  private closedCode: number | null = null;
  private readonly diagnosticWaiters = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly yoloReceived: HostAgentYoloFrame[] = [];
  private yoloWaiters: Array<() => void> = [];
  private receivedLeaseKeys: YoloLeaseKey[] | null = null;
  /** The local audit chain: what was written, and the last link. */
  private readonly yoloJournal: RelayYoloAuditEntry[] = [];

  constructor(private readonly options: HostAgentOptions) {}

  /** Every `yolo.lease` / `yolo.revoke` / `yolo.audit.ack` received so far. */
  get yoloFrames(): readonly HostAgentYoloFrame[] {
    return this.yoloReceived;
  }

  /** `link.context.leaseKeys` as last received, or `null`. */
  get leaseKeys(): readonly YoloLeaseKey[] | null {
    return this.receivedLeaseKeys;
  }

  /** Resolves with the first received YOLO frame (from `from` on) that matches. */
  waitYolo(match: (frame: HostAgentYoloFrame) => boolean, from = 0, timeoutMs = 10_000): Promise<HostAgentYoloFrame> {
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        const found = this.yoloReceived.slice(from).find(match);
        if (found) resolve(found);
        return Boolean(found);
      };
      if (check()) return;
      const timer = setTimeout(() => {
        this.yoloWaiters = this.yoloWaiters.filter((waiter) => waiter !== wake);
        reject(new Error("the expected YOLO frame did not arrive in time"));
      }, timeoutMs);
      const wake = () => {
        if (!check()) return;
        clearTimeout(timer);
        this.yoloWaiters = this.yoloWaiters.filter((waiter) => waiter !== wake);
      };
      this.yoloWaiters.push(wake);
    });
  }

  /** `yolo.state`: what this host says it holds; `killedAt` mimics `edge-setup yolo off`. */
  sendYoloState(leases: RelayYoloLeaseState[], killedAt?: number): void {
    this.sendText(killedAt === undefined ? { t: "yolo.state", leases } : { t: "yolo.state", leases, killedAt });
  }

  /**
   * Appends the records to the local chain and sends the whole unacknowledged
   * tail as one `yolo.audit`. `entryHash = SHA-256(0x01 || canonical(entry
   * without entryHash) || prevHash)`, written here independently of the code
   * under test.
   */
  sendYoloAudit(runtimeId: string, records: HostAgentYoloRecord[]): RelayYoloAuditFrame {
    for (const record of records) {
      const previous = this.yoloJournal.at(-1);
      const body = {
        seq: (previous?.seq ?? 0) + 1,
        eventId: randomUUID(),
        occurredAt: record.occurredAt ?? Math.floor(Date.now() / 1000),
        leaseId: record.leaseId,
        profile: record.profile,
        gateKind: record.gateKind,
        toolKey: record.toolKey,
        argsHash: createHash("sha256").update(record.args).digest("hex"),
        prevHash: previous?.entryHash ?? createHash("sha256").update(`ohb-yolo-audit/v1/genesis${runtimeId}`).digest("hex"),
      };
      this.yoloJournal.push({ ...body, entryHash: fakeYoloEntryHash(body) });
    }
    const frame = yoloAuditFrameOf(runtimeId, this.yoloJournal);
    this.sendText(frame);
    return frame;
  }

  /** Sends any `yolo.audit`, a tampered one included: the cloud must quarantine, not drop. */
  sendYoloAuditFrame(frame: RelayYoloAuditFrame): void {
    this.sendText(frame);
  }

  /** What `yolo.audit.ack` lets the host purge, as edge-setup does. */
  private purgeYoloJournal(toSeq: number): void {
    while (this.yoloJournal[0] && this.yoloJournal[0].seq <= toSeq) this.yoloJournal.shift();
  }

  private noteYolo(frame: HostAgentYoloFrame): void {
    this.yoloReceived.push(frame);
    if (frame.t === "yolo.audit.ack") this.purgeYoloJournal(frame.toSeq);
    for (const wake of [...this.yoloWaiters]) wake();
  }

  get linkIssued(): { runtimeId: string; linkToken: string } | null {
    return this.issued;
  }

  get closeCode(): number | null {
    return this.closedCode;
  }

  /** Opens one session: dial, hello, then serve frames until close. */
  async connect(): Promise<void> {
    const authorization = this.options.auth.kind === "enrollment"
      ? `Bearer enrollment:${this.options.auth.ticket}`
      : `Bearer link:${this.options.auth.runtimeId}.${this.options.auth.linkToken}`;
    const ws = new WebSocket(this.options.wsUrl, {
      headers: { Authorization: authorization },
      protocols: [SUBPROTOCOL],
    } as unknown as string[]);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.addEventListener("message", (event) => {
      void this.handleMessage(event.data as string | ArrayBuffer);
    });
    ws.addEventListener("close", (event) => {
      this.closedCode = event.code;
      for (const controller of this.inFlight.values()) controller.abort("link_closed");
      this.inFlight.clear();
      for (const pending of this.diagnosticWaiters.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Link closed before diagnostic acknowledgement"));
      }
      this.diagnosticWaiters.clear();
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error(`host agent could not dial ${this.options.wsUrl}`)), { once: true });
    });
    this.sendText({
      t: "hello", protocol: 1, agent: this.options.agent ?? "fake-host-agent/1",
      ...(this.options.features ? { features: this.options.features } : {}),
    });
  }

  /** Resolves once the broker has issued the link credentials (enrollment only). */
  waitLinkIssued(timeoutMs = 10_000): Promise<{ runtimeId: string; linkToken: string }> {
    if (this.issued) return Promise.resolve(this.issued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("link.issued did not arrive in time")), timeoutMs);
      this.issuedWaiters.push((issued) => {
        clearTimeout(timer);
        resolve(issued);
      });
    });
  }

  /** Sends one synthetic test event and waits for the post-commit ACK. */
  sendDiagnostic(frame: RelayDiagnosticFrame, timeoutMs = 10_000): Promise<void> {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Diagnostic requires an open link"));
    if (this.diagnosticWaiters.has(frame.eventId)) return Promise.reject(new Error("Diagnostic already pending"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.diagnosticWaiters.delete(frame.eventId);
        reject(new Error("Diagnostic acknowledgement did not arrive in time"));
      }, timeoutMs);
      this.diagnosticWaiters.set(frame.eventId, { resolve, reject, timer });
      this.sendText(frame);
    });
  }

  /** Updates inventory on the existing authenticated WebSocket. */
  announceCapabilities(features: string[]): void {
    this.sendText({ t: "capabilities", features });
  }

  close(code = 1000, reason = "bye"): void {
    this.ws?.close(code, reason);
  }

  private sendText(frame: RelayTextFrame): void {
    this.ws?.send(encodeTextFrame(frame));
  }

  private sendError(id: number, code: string, message: string, stage: "before_dispatch" | "after_dispatch"): void {
    this.sendText({ t: "err", id, code, message, stage });
  }

  private async handleMessage(data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string") {
      const { id, chunk } = decodeBinaryFrame(new Uint8Array(data));
      const chunks = this.requestBodies.get(id);
      if (chunks) chunks.push(chunk);
      return;
    }
    let frame: RelayTextFrame;
    try {
      frame = decodeTextFrame(data);
    } catch (error) {
      this.options.log?.("host_agent.frame_ignored", { error: String(error) });
      return;
    }
    switch (frame.t) {
      case "diagnostic.ack": {
        const pending = this.diagnosticWaiters.get(frame.eventId);
        if (pending) {
          clearTimeout(pending.timer);
          this.diagnosticWaiters.delete(frame.eventId);
          pending.resolve();
        }
        return;
      }
      case "ping":
        this.sendText({ t: "pong" });
        return;
      case "pong":
        return;
      case "link.issued":
        this.issued = { runtimeId: frame.runtimeId, linkToken: frame.linkToken };
        for (const wake of this.issuedWaiters.splice(0)) wake(this.issued);
        return;
      case "link.context":
        if (frame.leaseKeys) this.receivedLeaseKeys = frame.leaseKeys;
        return;
      case "yolo.lease":
      case "yolo.revoke":
      case "yolo.audit.ack":
        this.noteYolo(frame);
        return;
      case "req":
        if (frame.body === "stream") {
          this.requestBodies.set(frame.id, []);
          // The body arrives as binary frames; `end` triggers the dispatch.
          this.pendingRequests.set(frame.id, frame);
          return;
        }
        void this.serve(frame, null);
        return;
      case "end": {
        const request = this.pendingRequests.get(frame.id);
        if (!request) return;
        this.pendingRequests.delete(frame.id);
        const chunks = this.requestBodies.get(frame.id) ?? [];
        this.requestBodies.delete(frame.id);
        void this.serve(request, concat(chunks));
        return;
      }
      case "cancel":
      case "err": {
        this.pendingRequests.delete(frame.id);
        this.requestBodies.delete(frame.id);
        this.inFlight.get(frame.id)?.abort("cancelled");
        this.inFlight.delete(frame.id);
        return;
      }
      default:
        return;
    }
  }

  private readonly pendingRequests = new Map<number, RelayTextFrame & { t: "req" }>();

  private async serve(frame: RelayTextFrame & { t: "req" }, body: Uint8Array | null): Promise<void> {
    const route = matchRelayRoute(frame.method, frame.path);
    if (!route) {
      this.sendError(frame.id, "HERMES_LINK_PATH_FORBIDDEN", "route not in the connector allowlist", "before_dispatch");
      return;
    }
    if (body && body.byteLength > RELAY_MAX_REQUEST_BODY) {
      this.sendError(frame.id, "HERMES_PROTOCOL_LIMIT", "request body above the link bound", "before_dispatch");
      return;
    }
    if (route.events) {
      const since = replaySince(frame);
      if (since !== null && this.journal.has(runIdOfPath(frame.path))) {
        await this.serveReplay(frame, since);
        return;
      }
    }
    const controller = new AbortController();
    this.inFlight.set(frame.id, controller);
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(frame.headers ?? {})) {
        if (RELAY_FORWARDED_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
      }
      // The bearer is LOCAL: it never crossed the wire and never will.
      headers.set("Authorization", `Bearer ${this.options.gatewayToken}`);
      headers.delete("Cookie");
      let response: Response;
      try {
        response = await fetch(`${this.options.gatewayUrl}${frame.path}`, {
          method: frame.method,
          headers,
          body: body && body.byteLength > 0 ? (body as Uint8Array<ArrayBuffer>) : null,
          signal: controller.signal,
        });
      } catch {
        this.sendError(frame.id, "HERMES_UNREACHABLE", "gateway did not answer", "after_dispatch");
        return;
      }
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        if (RELAY_FORWARDED_RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders[name.toLowerCase()] = value;
      });
      const isCapabilities = strippedPath(frame.path) === "/v1/capabilities" && response.ok;
      const isRunCreate = frame.method.toUpperCase() === "POST" && strippedPath(frame.path).endsWith("/v1/runs") && response.ok;
      if (isCapabilities || isRunCreate) {
        // Bounded read: both bodies are small JSON documents.
        const raw = new Uint8Array(await response.arrayBuffer());
        let payload: Uint8Array = raw;
        if (isCapabilities) payload = withEventReplay(raw);
        if (isRunCreate) {
          const runId = runIdFromCreate(raw);
          if (runId) this.startTail(runId, profileOf(frame.path));
        }
        this.sendText({ t: "res", id: frame.id, status: response.status, headers: responseHeaders });
        this.ws?.send(encodeBinaryFrame(frame.id, payload));
        this.sendText({ t: "end", id: frame.id });
        return;
      }
      this.sendText({ t: "res", id: frame.id, status: response.status, headers: responseHeaders });
      if (response.body) {
        const reader = response.body.getReader();
        let total = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          total += value.byteLength;
          if (total > RELAY_MAX_RESPONSE_BODY) {
            this.sendError(frame.id, "HERMES_PROTOCOL_LIMIT", "response exceeds the stream limit", "after_dispatch");
            await reader.cancel().catch(() => undefined);
            return;
          }
          this.ws?.send(encodeBinaryFrame(frame.id, value));
        }
      }
      this.sendText({ t: "end", id: frame.id });
    } finally {
      this.inFlight.delete(frame.id);
    }
  }

  /** Replays the journal after `since`, `id:` per SSE frame, then live entries until terminal. */
  private async serveReplay(frame: RelayTextFrame & { t: "req" }, since: number): Promise<void> {
    const runId = runIdOfPath(frame.path);
    const journal = this.journal.get(runId);
    this.sendText({ t: "res", id: frame.id, status: 200, headers: { "content-type": "text/event-stream" } });
    if (!journal) {
      this.ws?.send(encodeBinaryFrame(frame.id, new TextEncoder().encode("event: replay-gap\ndata: {}\n\n")));
      this.sendText({ t: "end", id: frame.id });
      return;
    }
    let cursor = since;
    const encoder = new TextEncoder();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      for (const entry of journal.entries) {
        if (entry.seq <= cursor) continue;
        cursor = entry.seq;
        this.ws?.send(encodeBinaryFrame(frame.id, encoder.encode(`id: ${entry.seq}\n${entry.block}\n\n`)));
      }
      if (journal.terminal && (journal.entries.at(-1)?.seq ?? 0) <= cursor) break;
      await Bun.sleep(20);
    }
    this.sendText({ t: "end", id: frame.id });
  }

  /** One upstream subscription per run, independent of the link, feeding the journal. */
  private startTail(runId: string, profile: string): void {
    if (this.tails.has(runId)) return;
    this.tails.add(runId);
    const journal: Journal = { entries: [], terminal: false };
    this.journal.set(runId, journal);
    void (async () => {
      try {
        const response = await fetch(`${this.options.gatewayUrl}${profile}/v1/runs/${runId}/events`, {
          headers: { Accept: "text/event-stream", Authorization: `Bearer ${this.options.gatewayToken}` },
        });
        if (!response.ok || !response.body) {
          journal.terminal = true;
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let seq = 0;
        while (true) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary).trim();
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf("\n\n");
            if (!block || block.startsWith(":")) continue;
            seq += 1;
            journal.entries.push({ seq, block });
            if (/"event":\s*"run\.(completed|failed|cancelled|error)"/.test(block)) {
              journal.terminal = true;
            }
          }
          if (done) break;
        }
      } catch (error) {
        this.options.log?.("host_agent.tail_failed", { runId, error: String(error) });
      } finally {
        journal.terminal = true;
        this.tails.delete(runId);
      }
    })();
  }
}

/** Canonical JSON of a flat entry (sorted keys, ASCII strings, integers, null) is JSON.stringify of the sorted object. */
function fakeYoloEntryHash(body: Omit<RelayYoloAuditEntry, "entryHash">): string {
  const sorted = Object.fromEntries(Object.entries(body).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return createHash("sha256").update(Uint8Array.of(0x01)).update(JSON.stringify(sorted)).update(Buffer.from(body.prevHash, "hex")).digest("hex");
}

/** At most 128 entries per frame, as the contract bounds it; the rest goes after the ack. */
function yoloAuditFrameOf(runtimeId: string, journal: readonly RelayYoloAuditEntry[]): RelayYoloAuditFrame {
  const entries = journal.slice(0, 128);
  const first = entries[0];
  const last = entries.at(-1);
  if (!first || !last) throw new Error("the YOLO journal is empty: nothing to send");
  return { t: "yolo.audit", runtimeId, entries: [...entries], fromSeq: first.seq, toSeq: last.seq, tail: last.entryHash };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function strippedPath(path: string): string {
  const withoutQuery = path.split("?")[0] ?? "";
  return withoutQuery.replace(/^\/p\/[a-z0-9][a-z0-9_-]{0,62}/, "");
}

function profileOf(path: string): string {
  const match = /^\/p\/[a-z0-9][a-z0-9_-]{0,62}/.exec(path.split("?")[0] ?? "");
  return match ? match[0] : "";
}

function runIdOfPath(path: string): string {
  const stripped = strippedPath(path);
  const match = /^\/v1\/runs\/([A-Za-z0-9._~-]{1,128})\/events$/.exec(stripped);
  return match?.[1] ?? "";
}

function replaySince(frame: RelayTextFrame & { t: "req" }): number | null {
  for (const [name, value] of Object.entries(frame.headers ?? {})) {
    if (name.toLowerCase() === "last-event-id" && /^\d{1,15}$/.test(value.trim())) return Number(value.trim());
  }
  const query = frame.path.split("?")[1] ?? "";
  for (const pair of query.split("&")) {
    const [key, value] = pair.split("=");
    if (key === "since" && value && /^\d{1,15}$/.test(value)) return Number(value);
  }
  return null;
}

function withEventReplay(raw: Uint8Array): Uint8Array {
  try {
    const body = JSON.parse(new TextDecoder().decode(raw)) as { features?: Record<string, unknown> };
    body.features = { ...body.features, event_replay: true };
    return new TextEncoder().encode(JSON.stringify(body));
  } catch {
    return raw;
  }
}

function runIdFromCreate(raw: Uint8Array): string | null {
  try {
    const body = JSON.parse(new TextDecoder().decode(raw)) as { run_id?: unknown; id?: unknown };
    const candidate = body.run_id ?? body.id;
    return typeof candidate === "string" && /^[A-Za-z0-9._~-]{1,128}$/.test(candidate) ? candidate : null;
  } catch {
    return null;
  }
}
