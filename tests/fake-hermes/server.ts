/**
 * Deterministic stand-in for a Hermes gateway (`/v1/*` plus the handful of
 * `/api/*` reads openedbot performs). It serves two callers:
 *
 *   - `make load` (tests/load/run.sh): high capacity, instant runs;
 *   - the default `fake` development profile (`make fake-hermes`), where the
 *     seed and the API probe it exactly like a real runtime: `/health`,
 *     `/v1/capabilities`, `/v1/toolsets` under the toolset contract
 *     (modules/runtimes/src/domain/runtime-contract.ts) and `/api/model/options`.
 *
 * The host operator routes (`/hermes-setup/*`: capabilities, toolsets, MCP and
 * its catalogue, MCP OAuth, gateway restart, profiles) and the toolset and
 * skill reads that depend on them live in ./host-operator.ts, fed by the
 * fixtures under ./fixtures/.
 *
 * Nothing here talks to a model. Every run answers `OPENEDBOT_CANARY_OK <input>`.
 * Its address and bearer come from ./defaults.ts, never from a literal here.
 *
 * Approval gates (PERM2-A, DEV-OHB-250): a run whose input carries
 * `FAKE_APPROVAL:<gate>` tokens pauses on one `approval.request` per token, in
 * order, until `POST /v1/runs/{id}/approval` resolves it. `<gate>` is
 * `terminal` (a Hermes dangerous-command gate) or `plugin:<tool_key>` (a gate
 * raised by the openedbot approval plugin through `request_tool_approval`). The event
 * and the response route follow upstream `gateway/platforms/api_server.py`
 * (`_approval_request_event`) and `api_server_runs.py` (`_handle_run_approval`):
 * a `request_id` per gate, an optional `request_id` on the answer that targets
 * one gate, FIFO otherwise, and 409 `approval_not_pending` when nothing waits.
 */
import {
  FAKE_HERMES_CAPACITY,
  FAKE_HERMES_DELAY_MS,
  FAKE_HERMES_HOST,
  FAKE_HERMES_PORT,
  FAKE_HERMES_TOKEN,
} from "./defaults";
import { createFakeHost } from "./host-operator";

import type { Server } from "bun";

export type FakeHermesOptions = {
  hostname?: string;
  port?: number;
  token?: string;
  /** Delay between the first delta and the terminal event, in milliseconds. */
  delayMs?: number;
  /**
   * Extra `message.delta` frames between the first delta and the terminal
   * event, each `streamIntervalMs` apart: what a model streaming for a few
   * seconds looks like to the worker (one flush per 100 ms, OHB-133). Zero by
   * default so every other caller keeps the two-delta instant run.
   */
  streamDeltas?: number;
  /** Spacing of the extra deltas, in milliseconds. */
  streamIntervalMs?: number;
  /** Concurrent active runs before `POST /v1/runs` answers 429. */
  capacity?: number;
  /**
   * Session identifiers the host inventory lists although openedbot never created
   * them: what the worker's reconciliation must flag as `unattributed_session`.
   * Empty by default so a developer's fake runtime stays quiet.
   */
  unattributedSessions?: string[];
  /** Reads of a running gateway restart job before it settles (see host-operator.ts). */
  restartReads?: number;
  /** Emit a Todo tool turn with current, legacy and bridge transcript shapes. */
  emitTodoScenario?: boolean;
  /** Finish runs with the Hermes v0.22.2 gateway interruption event. */
  interruptRun?: boolean;
};

type FakeRunStatus = "queued" | "running" | "waiting_for_approval" | "completed" | "cancelled" | "interrupted";

/** One answer the fake received on `POST /v1/runs/{id}/approval`. */
export type FakeApprovalAnswer = { choice: string; requestId: string | null; resolvedRequestId: string };

type FakePendingApproval = {
  requestId: string;
  resolve: (choice: string) => void;
};

type FakeRun = {
  id: string;
  sessionId: string | null;
  input: string;
  status: FakeRunStatus;
  output: string | null;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number } | null;
  steers: string[];
  approvals: FakeApprovalAnswer[];
  /** Gates raised and not answered yet, oldest first (upstream resolves FIFO). */
  pendingApprovals: FakePendingApproval[];
  messages: unknown[];
  /** Text already streamed between the first and the last delta. */
  streamed: string;
};

const FAKE_APPROVAL_TOKEN = /FAKE_APPROVAL:(terminal|plugin:[a-z0-9_:.-]+)/gi;
const APPROVAL_CHOICES = ["once", "session", "always", "deny"] as const;
const APPROVAL_CHOICE_ALIASES: Record<string, string> = { approve: "once", approved: "once", allow: "once" };

/**
 * The `approval.request` payload Hermes emits for a gate, minus the run
 * envelope. A plugin gate carries the synthetic display target and the
 * `plugin_rule:` pattern key of `tools/approval.py` `request_tool_approval`;
 * the plugin's `message` is the description.
 */
const FAKE_ARGS_DIGEST = "0".repeat(64);
/** One plausible descriptor per native tool the plugin gates (spec §6). */
const FAKE_GATE_DESCRIPTORS: Record<string, { deletes: string; opaque: boolean; args: Record<string, unknown> }> = {
  write_file: { deletes: "no", opaque: false, args: { path: "notes/fake.md", size: 4 } },
  patch: { deletes: "no", opaque: false, args: { paths: ["notes/fake.md"], ops: ["update"] } },
  skill_manage: { deletes: "no", opaque: false, args: { action: "create", name: "fake-skill" } },
  send_message: { deletes: "no", opaque: false, args: { action: "send", platform: "telegram", target: "telegram:fake" } },
  execute_code: { deletes: "unknown", opaque: true, args: { language: "python", size: 20 } },
  cronjob: { deletes: "unknown", opaque: false, args: {} },
};

export function fakeApprovalGate(gate: string, requestId: string): Record<string, unknown> {
  if (gate.toLowerCase() === "terminal") {
    return {
      command: "rm -rf ./build",
      pattern_key: "recursive delete",
      pattern_keys: ["recursive delete"],
      description: "recursive delete",
      allow_permanent: true,
      allow_session: true,
      request_id: requestId,
      choices: [...APPROVAL_CHOICES],
    };
  }
  const toolKey = gate.slice("plugin:".length);
  const mcp = /^mcp:([^:]+):([^:]+)$/.exec(toolKey);
  // Hermes names an MCP tool `mcp__<server>__<tool>` (`tools/mcp_tool_schema.py`).
  const tool = mcp ? `mcp__${mcp[1]}__${mcp[2]}` : toolKey;
  const patternKey = `plugin_rule:ohb/v1/${toolKey}`;
  const described = mcp
    ? { deletes: "unknown", opaque: false, args: { server: mcp[1], tool: mcp[2], arguments: {} } }
    : FAKE_GATE_DESCRIPTORS[toolKey] ?? { deletes: "unknown", opaque: true, args: {} };
  // The descriptor line of `approval_policy_plugin/__init__.py`: the digest
  // covers the JSON text exactly as sent.
  const text = JSON.stringify({ v: 1, tool: toolKey, deletes: described.deletes, opaque: described.opaque, digest: FAKE_ARGS_DIGEST, args: described.args });
  const digest = new Bun.CryptoHasher("sha256").update(text).digest("hex");
  return {
    command: `<${tool}> (plugin approval rule)`,
    pattern_key: patternKey,
    pattern_keys: [patternKey],
    description: `Approve write-capable tool ${tool}.\nohb-gate/v1 ${digest} ${text}`,
    allow_permanent: true,
    allow_session: true,
    request_id: requestId,
    choices: [...APPROVAL_CHOICES],
  };
}

type FakeSession = {
  id: string;
  title: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  messages: unknown[];
};

const RUN_USAGE = { input_tokens: 2, output_tokens: 3, total_tokens: 5 } as const;

/** One authenticated provider, as `normalizeHermesModelOptions` reads it. */
const MODEL_OPTIONS = {
  provider: "fake",
  model: "fake/hermes",
  providers: [
    {
      slug: "fake",
      name: "Fake provider",
      is_current: true,
      authenticated: true,
      auth_type: "api_key",
      models: ["fake/hermes", "fake/hermes-fast"],
      capabilities: {
        "fake/hermes": { fast: false, reasoning: true },
        "fake/hermes-fast": { fast: true, reasoning: false },
      },
    },
  ],
} as const;

export function startFakeHermes(options: FakeHermesOptions = {}): Server<undefined> {
  const hostname = options.hostname ?? FAKE_HERMES_HOST;
  const port = options.port ?? FAKE_HERMES_PORT;
  const token = options.token ?? FAKE_HERMES_TOKEN;
  const delayMs = options.delayMs ?? FAKE_HERMES_DELAY_MS;
  const capacity = options.capacity ?? FAKE_HERMES_CAPACITY;
  const streamDeltas = Math.max(0, Math.floor(options.streamDeltas ?? 0));
  const streamIntervalMs = Math.max(0, options.streamIntervalMs ?? 100);
  const unattributedSessions = options.unattributedSessions ?? [];
  const host = createFakeHost({ restartReads: options.restartReads });
  const runs = new Map<string, FakeRun>();
  const sessions = new Map<string, FakeSession>();
  const idempotentRuns = new Map<string, string>();

  const isActive = (run: FakeRun) => run.status === "queued" || run.status === "running" || run.status === "waiting_for_approval";
  const activeRuns = () => [...runs.values()].filter(isActive).length;

  // Pause the stream on each gate the input asks for. A stop withdraws the
  // pending gate (upstream `withdraw_gateway_approval`), which is not a refusal.
  const awaitApprovals = async (run: FakeRun, emit: (event: Record<string, unknown>) => void) => {
    for (const match of run.input.matchAll(FAKE_APPROVAL_TOKEN)) {
      const status: string = run.status;
      if (status !== "running") return;
      const requestId = crypto.randomUUID().replace(/-/g, "");
      const answered = new Promise<string>((resolve) => {
        run.pendingApprovals.push({ requestId, resolve });
      });
      run.status = "waiting_for_approval";
      emit({ event: "approval.request", run_id: run.id, timestamp: Date.now() / 1_000, ...fakeApprovalGate(match[1]!, requestId) });
      const choice = await answered;
      if (choice === "__withdrawn__") return;
      run.status = "running";
      emit({ event: "approval.responded", run_id: run.id, timestamp: Date.now() / 1_000, choice, request_id: requestId, resolved: 1 });
    }
  };

  // Le faux ne lit jamais un steer : sans frontière d'outil, tout steer
  // accepté revient non lu sur le terminal, comme l'amont le documente
  // (`pending_steer` sur `run.completed` et sur le statut).
  const pendingSteer = (run: FakeRun) =>
    run.status === "completed" && run.steers.length > 0 ? { pending_steer: run.steers.join("\n") } : {};
  const completeRun = (run: FakeRun, cancelled: boolean) => {
    if (cancelled) {
      if (!isActive(run)) return;
      run.status = "cancelled";
      for (const pending of run.pendingApprovals.splice(0)) pending.resolve("__withdrawn__");
      return;
    }
    if (run.status !== "running") return;
    run.status = "completed";
    run.output = `OPENEDBOT_${run.streamed}CANARY_OK ${run.input}`.trim();
    run.usage = { ...RUN_USAGE };
    const session = run.sessionId ? sessions.get(run.sessionId) : undefined;
    if (session) {
      session.input_tokens += RUN_USAGE.input_tokens;
      session.output_tokens += RUN_USAGE.output_tokens;
    }
  };

  return Bun.serve({
    hostname,
    port,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/p\/[a-z0-9_-]+/i, "");
      const scopedProfile = /^\/p\/([a-z0-9_-]+)/i.exec(url.pathname)?.[1];
      const method = request.method;
      if (request.headers.get("Authorization") !== `Bearer ${token}` && path !== "/health") {
        return json({ error: "invalid_token" }, 401);
      }

      if (scopedProfile && !host.hasProfile(scopedProfile)) return json({ error: { code: "PROFILE_NOT_FOUND", message: "Unknown profile" } }, 404);
      const hostResponse = await host.handleHostRoute(request, path);
      if (hostResponse) return hostResponse;
      if (path === "/health") return json({ ok: true, service: "fake-hermes" });
      if (path === "/v1/capabilities") {
        return json({
          platform: "fake",
          version: "fake-hermes",
          features: { max_concurrent_runs: capacity, run_steer: true, approvals: true },
          endpoints: {
            run_steer: { method: "POST", path: "/v1/runs/{run_id}/steer" },
            run_approval: { method: "POST", path: "/v1/runs/{run_id}/approval" },
          },
        });
      }
      if (path === "/v1/models") return json({ data: [{ id: "fake/hermes" }, { id: "fake/hermes-fast" }] });
      if (path === "/v1/toolsets" && method === "GET") return json(host.toolsetsDocument(scopedProfile ?? null));
      if (path === "/v1/skills" && method === "GET") return json(host.skillsDocument(scopedProfile ?? null));
      if (path === "/api/model/options" && method === "GET") return json(MODEL_OPTIONS);

      // The host operator's bounded inventory (OHB-55): identifiers only, never
      // a title, a model or a message. Served by the fake gateway so the worker
      // reconciliation can be exercised without a real edge-setup host.
      if (path === "/hermes-setup/sessions-inventory" && method === "GET") {
        const known = [...sessions.keys()].map((id) => ({ id, profile: "default", createdAt: new Date(0).toISOString() }));
        const strangers = unattributedSessions.map((id) => ({ id, profile: "default", createdAt: new Date(0).toISOString() }));
        const all = [...known, ...strangers];
        return json({ sessions: all.slice(0, 500), total: all.length, truncated: all.length > 500 });
      }
      if (path === "/api/sessions" && method === "POST") {
        const body = await readJson<{ id?: unknown; title?: unknown }>(request);
        if (typeof body.id !== "string" || !body.id) return json({ error: "id_required" }, 400);
        if (sessions.has(body.id)) return json({ error: "exists" }, 409);
        sessions.set(body.id, {
          id: body.id,
          title: typeof body.title === "string" ? body.title : null,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          messages: [],
        });
        return json({ id: body.id }, 201);
      }
      const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(path);
      if (sessionMatch && method === "GET") {
        const session = sessions.get(decodeURIComponent(sessionMatch[1]!));
        if (!session) return json({ error: "not_found" }, 404);
        const { messages: _messages, ...sessionCounters } = session;
        return json({ session: sessionCounters });
      }
      const messagesMatch = /^\/api\/sessions\/([^/]+)\/messages$/.exec(path);
      if (messagesMatch && method === "GET") {
        const session = sessions.get(decodeURIComponent(messagesMatch[1]!));
        if (!session) return json({ error: "not_found" }, 404);
        return json({
          object: "list",
          session_id: session.id,
          data: session.messages,
          pagination: { limit: 128, offset: 0, order: "latest", returned: session.messages.length },
        });
      }
      // Même forme de réponse que `_handle_delete_session` du gateway amont :
      // `deleted: false` sur une session déjà absente, pas un 404. Le 404 est
      // réservé au cas où le gateway ne connaît pas du tout l'identifiant.
      if (sessionMatch && method === "DELETE") {
        const id = decodeURIComponent(sessionMatch[1]!);
        const existed = sessions.delete(id);
        if (!existed) return json({ error: "not_found" }, 404);
        return json({ object: "hermes.session.deleted", id, deleted: true });
      }

      if (path === "/v1/runs" && method === "POST") {
        const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() || null;
        if (idempotencyKey) {
          const existing = idempotentRuns.get(idempotencyKey);
          if (existing && runs.has(existing)) return json({ run_id: existing }, 200);
        }
        const body = await readJson<{ input?: unknown; session_id?: unknown }>(request);
        if (activeRuns() >= capacity) return json({ error: "capacity" }, 429);
        const id = `fake_${crypto.randomUUID()}`;
        runs.set(id, {
          id,
          sessionId: typeof body.session_id === "string" ? body.session_id : null,
          input: typeof body.input === "string" ? body.input : "",
          status: "queued",
          output: null,
          usage: null,
          steers: [],
          approvals: [],
          pendingApprovals: [],
          messages: [],
          streamed: "",
        });
        if (idempotencyKey) idempotentRuns.set(idempotencyKey, id);
        return json({ run_id: id }, 201);
      }

      const runMatch = /^\/v1\/runs\/([^/]+)(?:\/(events|stop|steer|approval))?$/.exec(path);
      if (runMatch) {
        const run = runs.get(decodeURIComponent(runMatch[1]!));
        if (!run) return json({ error: "not_found" }, 404);
        const action = runMatch[2] ?? null;

        if (action === null && method === "GET") {
          return json({ run_id: run.id, status: run.status, output: run.output, usage: run.usage, ...pendingSteer(run) });
        }
        if (action === "events" && method === "GET") {
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              const encoder = new TextEncoder();
              const emit = (event: Record<string, unknown>) =>
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
              run.status = "running";
              if (options.emitTodoScenario) {
                run.messages = [{
                  role: "assistant",
                  tool_calls: [
                    {
                      function: {
                        name: "tool_call",
                        arguments: JSON.stringify({ calls: [{
                          name: "todo_list",
                          arguments: { todos: [{ id: "inspect", content: "Inspect the runtime", status: "pending" }] },
                        }] }),
                      },
                    },
                    {
                      name: "todo",
                      arguments: { todos: [{ id: "ship", content: "Ship the compatibility", status: "completed" }], merge: true },
                    },
                  ],
                }];
                emit({ event: "tool.started", run_id: run.id, timestamp: Date.now() / 1_000, tool: "todo_list" });
                emit({ event: "tool.completed", run_id: run.id, timestamp: Date.now() / 1_000, tool: "todo_list", duration: 0.001, error: false });
                const session = run.sessionId ? sessions.get(run.sessionId) : undefined;
                if (session) session.messages = run.messages;
              }
              emit({ event: "message.interim", run_id: run.id, timestamp: Date.now() / 1_000, text: "Working", already_streamed: false });
              emit({
                event: "tool.started", run_id: run.id, timestamp: Date.now() / 1_000,
                tool: "fake_echo", preview: "Fake gateway run",
              });
              emit({
                event: "tool.completed", run_id: run.id, timestamp: Date.now() / 1_000,
                tool: "fake_echo", duration: 0.001, error: false, preview: "Fake gateway run",
              });
              await awaitApprovals(run, emit);
              const statusAfterApprovals: string = run.status;
              if (statusAfterApprovals === "cancelled") {
                emit({ event: "run.cancelled", run_id: run.id, timestamp: Date.now() / 1_000 });
                controller.close();
                return;
              }
              emit({ event: "message.delta", run_id: run.id, timestamp: Date.now() / 1_000, delta: "OPENEDBOT_" });
              for (let index = 0; index < streamDeltas && run.status === "running"; index += 1) {
                await Bun.sleep(streamIntervalMs);
                const delta = `chunk${index} `;
                run.streamed += delta;
                emit({ event: "message.delta", run_id: run.id, timestamp: Date.now() / 1_000, delta });
              }
              await Bun.sleep(delayMs);
              const statusAfterDelay: string = run.status;
              if (statusAfterDelay === "cancelled") {
                emit({ event: "run.cancelled", run_id: run.id, timestamp: Date.now() / 1_000 });
              } else if (options.interruptRun) {
                run.status = "interrupted";
                emit({ event: "run.interrupted", run_id: run.id, timestamp: Date.now() / 1_000, error: "Gateway restart" });
              } else {
                completeRun(run, false);
                emit({ event: "message.delta", run_id: run.id, timestamp: Date.now() / 1_000, delta: "CANARY_OK" });
                emit({
                  event: "run.completed", run_id: run.id, timestamp: Date.now() / 1_000,
                  output: run.output,
                  usage: run.usage,
                  messages: run.messages,
                  ...pendingSteer(run),
                });
              }
              controller.close();
            },
          });
          return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
        }
        if (action === "stop" && method === "POST") {
          completeRun(run, true);
          return new Response(null, { status: 204 });
        }
        if (action === "steer" && method === "POST") {
          if (run.status !== "queued" && run.status !== "running") return json({ error: "run_not_active", status: run.status }, 409);
          const body = await readJson<{ text?: unknown }>(request);
          if (typeof body.text !== "string" || !body.text.trim()) return json({ error: "text_required" }, 400);
          run.steers.push(body.text.trim());
          return json({ accepted: true, run_id: run.id, pending: run.steers.length }, 202);
        }
        if (action === "approval" && method === "POST") {
          const body = await readJson<{ choice?: unknown; request_id?: unknown }>(request);
          const rawChoice = String(body.choice ?? "").trim().toLowerCase();
          const choice = APPROVAL_CHOICE_ALIASES[rawChoice] ?? rawChoice;
          const requestId = typeof body.request_id === "string" ? body.request_id.trim() : "";
          if (body.request_id !== undefined && (!requestId || requestId.length > 256)) {
            return json({ error: { code: "invalid_approval_request", message: "Approval request_id is invalid." } }, 400);
          }
          if (!(APPROVAL_CHOICES as readonly string[]).includes(choice)) {
            return json({ error: { code: "invalid_approval_choice", message: "Invalid approval choice" } }, 400);
          }
          const index = requestId
            ? run.pendingApprovals.findIndex((pending) => pending.requestId === requestId)
            : run.pendingApprovals.length > 0 ? 0 : -1;
          if (index < 0) {
            return json({ error: { code: "approval_not_pending", message: `Run has no pending approval: ${run.id}` } }, 409);
          }
          const [pending] = run.pendingApprovals.splice(index, 1);
          run.approvals.push({ choice, requestId: requestId || null, resolvedRequestId: pending!.requestId });
          pending!.resolve(choice);
          return json({
            object: "hermes.run.approval_response",
            run_id: run.id,
            choice,
            ...(requestId ? { request_id: requestId } : {}),
            resolved: 1,
          });
        }
      }
      return json({ error: "not_found" }, 404);
    },
  });
}

async function readJson<T extends object>(request: Request): Promise<T> {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body as T : {} as T;
  } catch {
    return {} as T;
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

if (import.meta.main) {
  const capacity = Number(process.env.FAKE_HERMES_CAPACITY ?? FAKE_HERMES_CAPACITY);
  const server = startFakeHermes({
    hostname: process.env.FAKE_HERMES_HOST?.trim() || FAKE_HERMES_HOST,
    port: Number(process.env.FAKE_HERMES_PORT ?? FAKE_HERMES_PORT),
    token: process.env.FAKE_HERMES_TOKEN?.trim() || FAKE_HERMES_TOKEN,
    delayMs: Number(process.env.FAKE_HERMES_DELAY_MS ?? FAKE_HERMES_DELAY_MS),
    capacity,
    streamDeltas: Number(process.env.FAKE_HERMES_STREAM_DELTAS ?? 0),
    streamIntervalMs: Number(process.env.FAKE_HERMES_STREAM_INTERVAL_MS ?? 100),
  });
  console.info(JSON.stringify({ event: "fake_hermes.started", url: server.url.toString(), capacity }));
}
