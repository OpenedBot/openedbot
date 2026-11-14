import { describe, expect, test } from "bun:test";
import type { HermesClient, HermesEvent } from "@openedbot/hermes";
import type { RunEvent } from "../../src/domain/hermes-events";
import { providerAuthRequiredPayload } from "../../src/application/provider-fallback";
import { TRANSCRIPT_TOOLS as RUNNER_TRANSCRIPT_TOOLS } from "../../src/application/runner";
import { TRANSCRIPT_TOOLS, enrichFrameEvents } from "../../src/application/runner/frame-events";

const CONTEXT = { id: "run-1", organizationId: "org-1", sessionId: "session-1", workflowId: null };
const AT = new Date("2026-11-06T10:00:00Z");

function frame(event: string, extra: Record<string, unknown> = {}): HermesEvent {
  return { event, run_id: "hermes-1", timestamp: 1, ...extra };
}

function event(type: RunEvent["type"], payload: Record<string, unknown> = {}, sequence = 1): RunEvent {
  return { sequence, type, occurredAt: AT, payload };
}

/** A client whose only call is the transcript read, counted. */
function transcriptClient(messages: unknown[] | Error): { client: HermesClient; reads: () => number } {
  let reads = 0;
  const client = {
    async sessionMessages() {
      reads += 1;
      if (messages instanceof Error) throw messages;
      return messages;
    },
  } as unknown as HermesClient;
  return { client, reads: () => reads };
}

const noToolResults = { attachToolResults: () => [] as RunEvent[] };

function toolTranscript(tool: string, args: Record<string, unknown>, result: unknown, callId = "call-1"): unknown[] {
  return [
    { role: "user", content: "do it" },
    { role: "assistant", tool_calls: [{ id: callId, type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] },
    { role: "tool", tool_call_id: callId, content: JSON.stringify(result) },
  ];
}

describe("enrichFrameEvents", () => {
  test("le runner réexporte la même liste d'outils à relire", () => {
    expect(RUNNER_TRANSCRIPT_TOOLS).toBe(TRANSCRIPT_TOOLS);
  });

  test("une trame sans rien à compléter rend ses événements tels quels, sans relire", async () => {
    const { client, reads } = transcriptClient([]);
    const normalized = [event("agent.message", { text: "bon" })];
    const events = await enrichFrameEvents(CONTEXT, client, noToolResults, frame("message.delta"), normalized, {
      authRequiredProvider: null,
      createArgs: null,
    });
    expect(events).toEqual(normalized);
    expect(reads()).toBe(0);
  });

  test("le fournisseur qui a refusé la connexion nomme le run.error", async () => {
    const { client } = transcriptClient([]);
    const events = await enrichFrameEvents(CONTEXT, client, noToolResults, frame("run.error"), [
      event("run.error", { message: "401" }),
      event("agent.message", { text: "x" }, 2),
    ], { authRequiredProvider: "openai-codex", createArgs: null });
    expect(events[0]?.payload).toEqual(providerAuthRequiredPayload("openai-codex"));
    expect(events[1]?.payload).toEqual({ text: "x" });
  });

  test("un run.completed qui porte son tour ne relit pas la session et mesure le contexte", async () => {
    const { client, reads } = transcriptClient([]);
    const messages = toolTranscript("terminal", { command: "ls" }, { output: "a", exit_code: 0 }).slice(1);
    const attached = [event("tool.result", { tool: "terminal" }, 3)];
    const events = await enrichFrameEvents(
      CONTEXT,
      client,
      { attachToolResults: (turn) => (turn === messages ? attached : []) },
      frame("run.completed", { messages }),
      [event("run.completed", { output: "fini" }, 2)],
      { authRequiredProvider: null, createArgs: { input: "liste", images: [], instructions: "Tu es un bot.", history: [] } },
    );
    expect(reads()).toBe(0);
    expect(events).toHaveLength(2);
    expect(events[0]?.payload.turnMessages).toBe(messages);
    expect(events[0]?.payload.contextUsage).toBeTruthy();
    expect(events[1]).toBe(attached[0]);
  });

  test("un run.completed sans son tour relit la session une fois ; sans envoi connu, pas de mesure", async () => {
    const turn = toolTranscript("todo", { todos: [{ id: "1", content: "a", status: "pending" }] }, { todos: [] });
    const { client, reads } = transcriptClient(turn);
    const events = await enrichFrameEvents(CONTEXT, client, noToolResults, frame("run.completed"), [
      event("run.completed", { output: "fini" }),
    ], { authRequiredProvider: null, createArgs: null });
    expect(reads()).toBe(1);
    expect(Array.isArray(events[0]?.payload.turnMessages)).toBe(true);
    expect(events[0]?.payload.contextUsage).toBeUndefined();
  });

  test("un outil en échec reprend le message d'erreur du transcript, par identifiant d'appel", async () => {
    const turn = [
      ...toolTranscript("execute_code", { code: "1" }, { success: false, error: "first" }, "call-a"),
      ...toolTranscript("execute_code", { code: "2" }, { success: false, error: "second" }, "call-b").slice(1),
    ];
    const { client, reads } = transcriptClient(turn);
    const events = await enrichFrameEvents(
      CONTEXT,
      client,
      noToolResults,
      frame("tool.completed", { tool: "execute_code", error: true, tool_call_id: "call-a" }),
      [event("tool.result", { tool: "execute_code" })],
      { authRequiredProvider: null, createArgs: null },
    );
    expect(reads()).toBe(1);
    expect(events[0]?.payload.errorMessage).toBe("first");
  });

  test("un message d'erreur déjà porté n'est pas remplacé", async () => {
    const { client } = transcriptClient(toolTranscript("execute_code", { code: "1" }, { success: false, error: "transcript" }));
    const events = await enrichFrameEvents(
      CONTEXT,
      client,
      noToolResults,
      frame("tool.completed", { tool: "execute_code", error: true }),
      [event("tool.result", { tool: "execute_code", errorMessage: "sse" })],
      { authRequiredProvider: null, createArgs: null },
    );
    expect(events[0]?.payload.errorMessage).toBe("sse");
  });

  test("une relecture impossible ne fait pas échouer la trame", async () => {
    const { client, reads } = transcriptClient(new Error("gateway down"));
    const normalized = [event("tool.result", { tool: "todo" })];
    const events = await enrichFrameEvents(CONTEXT, client, noToolResults, frame("tool.completed", { tool: "todo" }), normalized, {
      authRequiredProvider: null,
      createArgs: null,
    });
    expect(reads()).toBe(1);
    expect(events).toEqual(normalized);
  });

  test("un outil hors liste qui réussit ne déclenche aucune relecture", async () => {
    const { client, reads } = transcriptClient([]);
    await enrichFrameEvents(CONTEXT, client, noToolResults, frame("tool.completed", { tool: "read_file" }), [
      event("tool.result", { tool: "read_file" }),
    ], { authRequiredProvider: null, createArgs: null });
    expect(reads()).toBe(0);
  });
});
