import { describe, expect, test } from "bun:test";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import {
  answeredRunIds,
  concludedRunIds,
  parseThreadEventWindow,
  preservedRunIds,
  PRESERVED_RECENT_RUNS,
  snapshotCursor,
  windowThreadEvents,
} from "../src/domain/thread-snapshot-window";

type Event = { cursor: number; runId: string; type: string; payload: Record<string, unknown> };

const event = (cursor: number, runId: string, type: string, payload: Record<string, unknown> = {}): Event =>
  ({ cursor, runId, type, payload });

/**
 * Un fil réaliste : un vieux tour conclu et répondu (`run-old`), un tour conclu
 * mais RÉCENT, et un tour encore en cours. Les runs arrivent du plus ancien au
 * plus récent, comme la requête du snapshot les rend.
 */
function thread() {
  const events: Event[] = [
    event(1, "run-old", "agent.message", { text: "bon" }),
    event(2, "run-old", "tool.call", { tool: "shell", preview: "ls" }),
    event(3, "run-old", "raw", { blob: "x" }),
    event(4, "run-old", "agent.reasoning", { text: "hmm" }),
    event(5, "run-old", "tool.result", { durationMs: 12 }),
    event(6, "run-old", "tool.result.attached", { result: "fichiers" }),
    event(7, "run-old", "agent.message", { text: "jour" }),
    event(8, "run-old", "system.notice", { kind: "handoff.sent", text: "→ neo" }),
    event(9, "run-old", "approval.responded", { choice: "once" }),
    event(10, "run-old", "bot.message", { messageId: "m-old" }),
    event(11, "run-old", "run.completed", {}),
    event(12, "run-recent", "agent.message", { text: "salut" }),
    event(13, "run-recent", "run.completed", {}),
    event(14, "run-live", "agent.message", { text: "je réfléchis" }),
  ];
  const runs = [{ id: "run-old" }, { id: "run-recent" }, { id: "run-live" }];
  const messages = [
    { role: "user", runId: "run-old" },
    { role: "assistant", runId: "run-old" },
    { role: "assistant", runId: "run-recent" },
  ];
  return { events, runs, messages };
}

function compact(fixture = thread(), runs = fixture.runs) {
  return windowThreadEvents(fixture.events, {
    window: "compact",
    preservedRunIds: preservedRunIds(runs, fixture.events),
    concludedRunIds: concludedRunIds(fixture.events),
    answeredRunIds: answeredRunIds(fixture.messages),
  });
}

/** Les runs récents protégés masqueraient la coupe : on les pousse dehors. */
function withPadding() {
  const fixture = thread();
  const padded = [
    ...Array.from({ length: PRESERVED_RECENT_RUNS }, (_, index) => ({ id: `run-pad-${index}` })),
    ...fixture.runs,
  ];
  // `run-old` sort ainsi de la fenêtre protégée sans que rien d'autre ne bouge.
  return { fixture, runs: padded.filter((run) => run.id !== "run-old") };
}

describe("fenêtrage des événements du snapshot", () => {
  test("`full` rend exactement le tableau reçu", () => {
    const fixture = thread();
    expect(windowThreadEvents(fixture.events, {
      window: "full",
      preservedRunIds: new Set(),
      concludedRunIds: new Set(["run-old"]),
      answeredRunIds: new Set(["run-old"]),
    })).toBe(fixture.events);
  });

  test("retire les deltas, `raw` et `agent.reasoning` d'un run conclu et répondu", () => {
    const { fixture, runs } = withPadding();
    const kept = compact(fixture, runs);
    const old = kept.filter((item) => item.runId === "run-old");
    expect(old.map((item) => item.type)).toEqual([
      // Le premier delta reste : c'est l'ancre de rangée du client natif.
      "agent.message",
      "tool.call",
      "tool.result",
      "tool.result.attached",
      "system.notice",
      "approval.responded",
      "bot.message",
      "run.completed",
    ]);
    // Les deltas SUIVANTS, eux, ne voyagent plus.
    expect(JSON.stringify(old)).not.toContain("jour");
    expect(old.filter((item) => item.type === "agent.message")).toHaveLength(1);
    expect(old[0]?.cursor).toBe(1);
  });

  test("l'ancre est le premier delta PORTEUR de texte, pas un delta vide", () => {
    const fixture = thread();
    fixture.events = [
      event(1, "run-old", "agent.message", {}),
      event(2, "run-old", "agent.message", { text: "" }),
      event(3, "run-old", "agent.message", { text: "vrai début" }),
      event(4, "run-old", "agent.message", { text: " et la suite" }),
      event(5, "run-old", "run.completed", {}),
      event(6, "run-live", "agent.message", { text: "en cours" }),
    ];
    const { runs } = withPadding();
    const deltas = compact(fixture, runs).filter(
      (item) => item.runId === "run-old" && item.type === "agent.message",
    );
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.cursor).toBe(3);
  });

  test("le fenêtrage est déterministe : deux appels rendent le même résultat", () => {
    const { fixture, runs } = withPadding();
    expect(compact(fixture, runs).map((item) => item.cursor))
      .toEqual(compact(fixture, runs).map((item) => item.cursor));
  });

  test("garde intégralement le run en cours et les runs récents", () => {
    const kept = compact();
    expect(kept.filter((item) => item.runId === "run-live")).toHaveLength(1);
    expect(kept.filter((item) => item.runId === "run-recent").map((item) => item.type))
      .toEqual(["agent.message", "run.completed"]);
    // `run-old` est dans les trois derniers runs du fil : rien ne bouge non plus.
    expect(kept).toHaveLength(thread().events.length);
  });

  test("garde les deltas d'un run conclu SANS réponse persistée", () => {
    const fixture = thread();
    fixture.messages = fixture.messages.filter((message) => message.role !== "assistant");
    const { runs } = withPadding();
    const kept = compact(fixture, runs);
    expect(kept.filter((item) => item.runId === "run-old" && item.type === "agent.message"))
      .toHaveLength(2);
  });

  test("garde tout d'un run que rien ne déclare conclu", () => {
    const fixture = thread();
    fixture.events = fixture.events.filter((item) => item.type !== "run.completed");
    const { runs } = withPadding();
    expect(compact(fixture, runs).filter((item) => item.runId === "run-old" && item.type === "raw"))
      .toHaveLength(1);
  });

  test("le run du dernier événement est protégé même absent de la liste des runs", () => {
    const fixture = thread();
    // Un tour de salon né après la lecture de `runs`.
    fixture.events = [...fixture.events, event(15, "run-unlisted", "agent.message", { text: "moi" })];
    const preserved = preservedRunIds([{ id: "run-a" }, { id: "run-b" }, { id: "run-c" }], fixture.events);
    expect(preserved.has("run-unlisted")).toBe(true);
  });

  test("`run.error` conclut un run au même titre que `run.completed`", () => {
    expect([...concludedRunIds([event(1, "run-x", "run.error", { message: "boom" })])]).toEqual(["run-x"]);
  });

  test("le curseur se lit sur les événements bruts, jamais sur ceux qui restent", () => {
    const fixture = thread();
    const { runs } = withPadding();
    expect(snapshotCursor(fixture.events)).toBe(14);
    // La preuve du non-régression de la garde anti-snapshot-périmé : le
    // dernier événement retiré ne fait pas reculer le curseur annoncé.
    const kept = compact(fixture, runs);
    expect(snapshotCursor(fixture.events)).toBeGreaterThanOrEqual(snapshotCursor(kept));
    expect(snapshotCursor(fixture.events)).toBe(14);
  });

  test("le curseur tient sur des milliers d'événements et ignore les valeurs illisibles", () => {
    const many = Array.from({ length: 200_000 }, (_, index) => ({ cursor: index + 1 }));
    expect(snapshotCursor(many)).toBe(200_000);
    expect(snapshotCursor([{ cursor: "12" }, { cursor: null }, { cursor: Number.NaN }])).toBe(12);
    expect(snapshotCursor([])).toBe(0);
  });

  test("un événement sans `runId` exploitable n'est jamais jeté", () => {
    const orphan = [{ runId: null, type: "raw" }];
    expect(windowThreadEvents(orphan, {
      window: "compact",
      preservedRunIds: new Set(),
      concludedRunIds: new Set(),
      answeredRunIds: new Set(),
    })).toHaveLength(1);
  });

  test("le paramètre `events` refuse ce qu'il ne connaît pas", () => {
    expect(parseThreadEventWindow(undefined)).toBe("full");
    expect(parseThreadEventWindow("full")).toBe("full");
    expect(parseThreadEventWindow("compact")).toBe("compact");
    expect(() => parseThreadEventWindow("")).toThrow(HttpError);
    expect(() => parseThreadEventWindow("COMPACT")).toThrow(HttpError);
    expect(() => parseThreadEventWindow("minimal")).toThrow(HttpError);
  });

  test("`answeredRunIds` ignore les messages sans run et les messages utilisateur", () => {
    expect([...answeredRunIds([
      { role: "assistant", runId: null },
      { role: "user", runId: "run-u" },
      { role: "assistant", runId: "run-a" },
    ])]).toEqual(["run-a"]);
  });
});
