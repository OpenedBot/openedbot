import { describe, expect, test } from "bun:test";
import { HERMES_RUN_FAILURE_CODE, HERMES_RUN_INTERRUPTED_CODE, MODEL_UNAVAILABLE_CODE, NO_USABLE_PROVIDER_CODE } from "@openedbot/contracts-errors";
import {
  HERMES_RUN_FAILURE_MESSAGE,
  HermesEventNormalizer,
  NO_USABLE_PROVIDER_MESSAGE,
  TOOL_ERROR_MESSAGE_MAX_CHARS,
  hermesRunFailure,
  readToolCompletionText,
  sanitizeToolErrorMessage,
} from "../src/domain/hermes-events";

/** Le texte exact mesuré le 31-08 dans une bulle de conversation. */
const UPSTREAM_PROVIDER_FAILURE =
  "Provider authentication failed: No inference provider configured. Run 'hermes model' " +
  "to choose a provider and model, or set an API key (OPENROUTER_API_KEY, OPENAI_API_KEY, etc.) in ~/.hermes/.env.";

test("MODEL_UNAVAILABLE_CODE garde la valeur que la console épingle", () => {
  // `apps/console/src/lib/run/model-unavailable.ts` recopie cette valeur sans
  // importer le paquet : la changer casse l'alerte de la console.
  expect(MODEL_UNAVAILABLE_CODE).toBe("MODEL_UNAVAILABLE");
});

describe("hermesRunFailure", () => {
  test("la consigne d'administration Hermes devient la phrase produit", () => {
    const failure = hermesRunFailure({ message: UPSTREAM_PROVIDER_FAILURE });

    expect(failure.message).toBe(NO_USABLE_PROVIDER_MESSAGE);
    expect(failure.errorCode).toBe(NO_USABLE_PROVIDER_CODE);
    // Ni shell, ni chemin de fichier, ni nom de variable d'environnement.
    expect(failure.message).not.toContain("hermes model");
    expect(failure.message).not.toContain(".hermes/.env");
    expect(failure.message).not.toContain("API_KEY");
  });

  test("un modèle refusé par le fournisseur porte MODEL_UNAVAILABLE et garde son texte", () => {
    const failure = hermesRunFailure({ message: "HTTP 400: Upstream request failed: Model is unavailable." });

    expect(failure.errorCode).toBe(MODEL_UNAVAILABLE_CODE);
    expect(failure.message).toBe("HTTP 400: Upstream request failed: Model is unavailable.");
    expect(hermesRunFailure({
      error: "The model `x` does not exist or you do not have access to it. Authorization: Bearer sk-abcdefghijklmnopqrstuvwx",
    })).toMatchObject({ errorCode: MODEL_UNAVAILABLE_CODE });
    expect(hermesRunFailure({
      error: "model_not_found Authorization: Bearer sk-abcdefghijklmnopqrstuvwx",
    }).message).not.toContain("sk-abcdefghijklmnop");
  });

  test("réseau, quota ou annulation ne portent pas MODEL_UNAVAILABLE", () => {
    for (const message of [
      "HTTP 429: The usage limit has been reached",
      "HTTP 503: Service unavailable",
      "connection reset by peer",
      "Run cancelled by user",
    ]) {
      expect(hermesRunFailure({ message }).errorCode).toBe(HERMES_RUN_FAILURE_CODE);
    }
  });

  test("un échec sans texte tombe sur la phrase générique", () => {
    expect(hermesRunFailure({})).toEqual({
      message: HERMES_RUN_FAILURE_MESSAGE,
      errorCode: HERMES_RUN_FAILURE_CODE,
    });
    expect(hermesRunFailure({ message: "   " }).message).toBe(HERMES_RUN_FAILURE_MESSAGE);
  });

  test("un échec déjà lisible garde ses mots", () => {
    expect(hermesRunFailure({ error: "Le contrat d'outils n'a pas été respecté." })).toEqual({
      message: "Le contrat d'outils n'a pas été respecté.",
      errorCode: HERMES_RUN_FAILURE_CODE,
    });
  });
});

describe("HermesEventNormalizer : run.error", () => {
  test("run.failed et run.error passent par le même filtre", () => {
    for (const event of ["run.failed", "run.error"]) {
      const events = new HermesEventNormalizer().push({
        event,
        run_id: "run_1",
        timestamp: 1_700_000_000,
        message: UPSTREAM_PROVIDER_FAILURE,
      });

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("run.error");
      expect(events[0]!.payload).toEqual({
        message: NO_USABLE_PROVIDER_MESSAGE,
        errorCode: NO_USABLE_PROVIDER_CODE,
      });
    }
  });

  test("run.interrupted devient un échec distinct et message.interim reste silencieux", () => {
    const normalizer = new HermesEventNormalizer();
    const interrupted = normalizer.push({
      event: "run.interrupted",
      run_id: "run_1",
      timestamp: 1_700_000_000,
      error: "Gateway restart",
    });
    expect(interrupted[0]).toMatchObject({
      type: "run.error",
      payload: {
        errorCode: HERMES_RUN_INTERRUPTED_CODE,
        message: "Le gateway Hermes a interrompu le run, probablement lors d’un redémarrage.",
      },
    });
    expect(normalizer.push({
      event: "message.interim",
      run_id: "run_1",
      timestamp: 1_700_000_001,
      text: "Working",
      already_streamed: false,
    })).toEqual([]);
  });
});

describe("HermesEventNormalizer : todo plan", () => {
  test("projette todo_list, l’alias todo et le bridge tool_call", () => {
    const events = new HermesEventNormalizer().push({
      event: "run.completed",
      run_id: "run_plan",
      timestamp: 1_700_000_000,
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              function: {
                name: "todo_list",
                arguments: JSON.stringify({
                  todos: [
                    { id: "inspect", content: "Inspecter le fil", status: "pending" },
                    { id: "ship", content: "Livrer le changement", status: "pending" },
                  ],
                }),
              },
            },
          ],
        },
        {
          role: "assistant",
          tool_calls: [{
            function: {
              name: "tool_call",
              arguments: JSON.stringify({ calls: [{
                name: "todo_list",
                arguments: { todos: [{ id: "inspect", status: "completed" }], merge: true },
              }] }),
            },
          }],
        },
        {
          role: "assistant",
          tool_calls: [
            {
              name: "todo",
              arguments: JSON.stringify({
                todos: [{ id: "ship", status: "in_progress" }],
                merge: true,
              }),
            },
          ],
        },
      ],
    });

    expect(events[0]?.payload.agentPlan).toEqual({
      steps: [
        { id: "inspect", content: "Inspecter le fil", status: "completed" },
        { id: "ship", content: "Livrer le changement", status: "in_progress" },
      ],
    });
  });

  test("ignore les lectures todo et les tool calls sans arguments lisibles", () => {
    const events = new HermesEventNormalizer().push({
      event: "run.completed",
      run_id: "run_no_plan",
      timestamp: 1_700_000_000,
      messages: [
        { role: "assistant", tool_calls: [{ name: "todo" }] },
        { role: "assistant", tool_calls: [{ name: "todo", arguments: "not-json" }] },
      ],
    });

    expect(events[0]?.payload).not.toHaveProperty("agentPlan");
  });
});

describe("HermesEventNormalizer : recherches web", () => {
  test("projette les recherches du tour livrées dans run.completed", () => {
    const events = new HermesEventNormalizer().push({
      event: "run.completed",
      run_id: "run_search",
      timestamp: 1_700_000_000,
      // `messages` est le transcript DU TOUR : l'amont l'a déjà borné, il ne
      // porte donc jamais les recherches d'un tour précédent.
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              function: {
                name: "web_search",
                arguments: JSON.stringify({ query: "horoscope Sagittaire septembre octobre 2026", limit: 5 }),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: JSON.stringify({
            success: true,
            data: { web: [{ title: "Sagittaire", url: "https://exemple.test/sagittaire" }] },
          }),
        },
      ],
    });

    expect(events[0]?.payload.webSearch).toEqual({
      queries: [
        {
          id: "call_1",
          query: "horoscope Sagittaire septembre octobre 2026",
          sources: [
            {
              title: "Sagittaire",
              url: "https://exemple.test/sagittaire",
              domain: "exemple.test",
              description: null,
            },
          ],
          resultCount: 1,
          error: null,
        },
      ],
    });
  });

  test("un tour sans recherche ne pose pas de trace", () => {
    const events = new HermesEventNormalizer().push({
      event: "run.completed",
      run_id: "run_no_search",
      timestamp: 1_700_000_000,
      messages: [{ role: "assistant", content: "réponse directe" }],
    });

    expect(events[0]?.payload).not.toHaveProperty("webSearch");
  });
});

describe("sanitizeToolErrorMessage", () => {
  test("texte brut : ANSI et contrôles retirés, espaces repliés, vide = null", () => {
    expect(sanitizeToolErrorMessage("\u001b[31mError:\u001b[0m  file\tnot\nfound ")).toBe("Error: file not found");
    expect(sanitizeToolErrorMessage("   ")).toBeNull();
    expect(sanitizeToolErrorMessage(undefined)).toBeNull();
    expect(sanitizeToolErrorMessage({ error: "x" })).toBeNull();
  });

  test("les secrets sont masqués, le reste du message survit", () => {
    expect(sanitizeToolErrorMessage("401 with Authorization: Bearer abcdefghijklmnop123")).toBe(
      "401 with Authorization: [redacted]",
    );
    expect(sanitizeToolErrorMessage("OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz invalid")).toBe(
      "OPENAI_API_KEY=[redacted] invalid",
    );
    expect(sanitizeToolErrorMessage("token: \"ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345\" rejected")).toBe(
      "token: [redacted] rejected",
    );
    expect(sanitizeToolErrorMessage("skill 'foo' not found")).toBe("skill 'foo' not found");
  });

  test("borné à TOOL_ERROR_MESSAGE_MAX_CHARS, avec une ellipse", () => {
    const text = sanitizeToolErrorMessage("x".repeat(2_000))!;
    expect(text.length).toBe(TOOL_ERROR_MESSAGE_MAX_CHARS);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("readToolCompletionText", () => {
  test("un runtime sans preview ne fournit aucun texte", () => {
    expect(readToolCompletionText({ tool: "skill_manage", duration: 0.027, error: true })).toEqual({
      errorMessage: null,
      resultExcerpt: null,
    });
  });

  test("reconnaît les champs qu'un runtime pourrait ajouter, sans en inventer", () => {
    expect(readToolCompletionText({ error: true, error_message: "skill exists" }).errorMessage).toBe("skill exists");
    expect(readToolCompletionText({ error: "permission denied" }).errorMessage).toBe("permission denied");
    expect(readToolCompletionText({ error: true, result: { error: "boom" } }).errorMessage).toBe("boom");
    expect(readToolCompletionText({ error: true, result: "stderr text" })).toEqual({
      errorMessage: "stderr text",
      resultExcerpt: "stderr text",
    });
    // Un résultat SANS erreur n'est pas un message d'erreur.
    expect(readToolCompletionText({ error: false, result: "ok" })).toEqual({ errorMessage: null, resultExcerpt: "ok" });
  });

  test("lit les erreurs JSON et le texte brut du preview", () => {
    expect(readToolCompletionText({
      error: true,
      preview: '{"status":"error","error":"Python 3 is not available"}',
    }).errorMessage).toBe("Python 3 is not available");
    expect(readToolCompletionText({ error: true, preview: "BLOCKED: policy denied this request" }).errorMessage)
      .toBe("BLOCKED: policy denied this request");
    expect(readToolCompletionText({ error: false, preview: "ok text" }))
      .toEqual({ errorMessage: null, resultExcerpt: "ok text" });
  });

  test("borne et masque le preview avant sa persistance", () => {
    expect(readToolCompletionText({ error: false, preview: "x".repeat(700) }).resultExcerpt)
      .toHaveLength(500);
    expect(readToolCompletionText({ error: false, preview: "key sk-abcdefghijklmnopqrstuvwxyz123456 rejected" }).resultExcerpt)
      .toBe("key [redacted] rejected");
  });

  test("un preview JSON signalé en erreur fournit son résumé", () => {
    expect(readToolCompletionText({
      error: false,
      preview: '{"success":false,"user_summary":"Permission denied"}',
    })).toEqual({ errorMessage: "Permission denied", resultExcerpt: null });
  });
});

describe("HermesEventNormalizer : tool.completed", () => {
  test("un échec sans texte est persisté comme tel : errorMessage null, aucun extrait", () => {
    const normalizer = new HermesEventNormalizer();
    normalizer.push({ event: "tool.started", run_id: "r", timestamp: 1, tool: "skill_manage" });
    const [result] = normalizer.push({
      event: "tool.completed", run_id: "r", timestamp: 1.5, tool: "skill_manage", duration: 0.027, error: true,
    });
    expect(result?.type).toBe("tool.result");
    expect(result?.payload).toEqual({
      toolCallId: "tc_0",
      tool: "skill_manage",
      durationMs: 27,
      error: true,
      errorMessage: null,
      resultExcerpt: null,
      hasResultPayload: false,
    });
  });

  test("un texte d'erreur amont remonte borné et rédigé", () => {
    const normalizer = new HermesEventNormalizer();
    normalizer.push({ event: "tool.started", run_id: "r", timestamp: 1, tool: "terminal" });
    const [result] = normalizer.push({
      event: "tool.completed", run_id: "r", timestamp: 2, tool: "terminal", duration: 1,
      error: "curl: (22) 401 Authorization: Bearer abcdefghijklmnopqrstu",
    });
    expect(result?.payload.error).toBe(true);
    expect(result?.payload.errorMessage).toBe("curl: (22) 401 Authorization: [redacted]");
    expect(result?.payload.hasResultPayload).toBe(false);
  });

  test("le preview de résultat alimente l'extrait et le motif d'échec", () => {
    const normalizer = new HermesEventNormalizer();
    normalizer.push({ event: "tool.started", run_id: "r", timestamp: 1, tool: "execute_code" });
    const [result] = normalizer.push({
      event: "tool.completed", run_id: "r", timestamp: 2, tool: "execute_code", duration: 0.062,
      error: true, preview: '{"status":"error","error":"kernel unavailable"}',
    });
    expect(result?.payload).toMatchObject({
      tool: "execute_code",
      error: true,
      errorMessage: "kernel unavailable",
      resultExcerpt: null,
      hasResultPayload: false,
    });
  });

  test("attache les résultats dans l'ordre du transcript et utilise les identifiants amont", () => {
    const normalizer = new HermesEventNormalizer();
    const [first] = normalizer.push({
      event: "tool.started", run_id: "r", timestamp: 1, tool: "terminal", tool_call_id: "upstream-1",
    });
    const [second] = normalizer.push({
      event: "tool.started", run_id: "r", timestamp: 2, tool: "terminal", tool_call_id: "upstream-2",
    });
    const [completedSecond] = normalizer.push({
      event: "tool.completed", run_id: "r", timestamp: 3, tool: "terminal", tool_call_id: "upstream-2", error: false,
    });
    expect(completedSecond?.payload.toolCallId).toBe(second?.payload.toolCallId);

    const attached = normalizer.attachToolResults([
      {
        role: "assistant",
        tool_calls: [
          { id: "upstream-2", function: { name: "terminal", arguments: '{"command":"second"}' } },
          { id: "upstream-1", function: { name: "terminal", arguments: '{"command":"first"}' } },
        ],
      },
      { role: "tool", tool_call_id: "upstream-1", content: "first result" },
      { role: "tool", tool_call_id: "upstream-2", content: "second result" },
    ], new Date("2026-10-17T12:00:00.000Z"));
    expect(attached.map((event) => event.sequence)).toEqual([3, 4]);
    expect(attached.map((event) => event.payload.toolCallId)).toEqual([
      second?.payload.toolCallId,
      first?.payload.toolCallId,
    ]);
    expect(attached.map((event) => event.payload.input)).toEqual(["second", "first"]);
    expect(normalizer.attachToolResults([])).toEqual([]);
  });

  test("does not assign transcript results when the tool call count drifted", () => {
    const normalizer = new HermesEventNormalizer();
    normalizer.push({ event: "tool.started", run_id: "r", timestamp: 1, tool: "terminal" });
    normalizer.push({ event: "tool.started", run_id: "r", timestamp: 2, tool: "terminal" });
    const attached = normalizer.attachToolResults([{
      role: "assistant",
      tool_calls: [{ id: "call-1", function: { name: "terminal", arguments: '{"command":"false"}' } }],
    }, { role: "tool", tool_call_id: "call-1", content: "private result" }]);
    expect(attached).toHaveLength(2);
    expect(attached.map((event) => event.payload.ambiguous)).toEqual([true, true]);
    expect(attached.every((event) => !("result" in event.payload))).toBe(true);
  });

  test("restores open calls and the id counter when a worker resumes a run", () => {
    const normalizer = new HermesEventNormalizer(20, {
      priorToolCalls: [
        { tool: "terminal", toolCallId: "tc_3", completed: true },
        { tool: "terminal", toolCallId: "tc_9", completed: false },
      ],
    });
    const [completed] = normalizer.push({ event: "tool.completed", run_id: "r", timestamp: 1, tool: "terminal" });
    const [started] = normalizer.push({ event: "tool.started", run_id: "r", timestamp: 2, tool: "terminal" });
    expect(completed?.payload.toolCallId).toBe("tc_9");
    expect(started?.payload.toolCallId).toBe("tc_10");
  });
});

describe("HermesEventNormalizer.skipPast", () => {
  // The worker writes `run.provider_fallback` itself between two Hermes
  // attempts. Sharing its sequence made the next attempt's first delta lose
  // its insert (`on conflict do nothing`): "ello" for "hello".
  test("the first delta after an event written elsewhere takes the next sequence", () => {
    const normalizer = new HermesEventNormalizer(3, { flushFirstDelta: true });
    normalizer.skipPast(3);
    const [first] = normalizer.push({ event: "message.delta", run_id: "r", timestamp: 1, delta: "h" });
    expect(first).toMatchObject({ sequence: 4, type: "agent.message", payload: { text: "h" } });
    normalizer.skipPast(1);
    const [completed] = normalizer.push({ event: "run.completed", run_id: "r", timestamp: 2, output: "hello" });
    expect(completed?.sequence).toBe(5);
  });
});
