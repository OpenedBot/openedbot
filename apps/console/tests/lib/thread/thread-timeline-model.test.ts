import { describe, expect, test } from "bun:test";
import type { ThreadSnapshot } from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import { applyProductEventToSnapshot } from "@openedbot/conversation/domain/thread-snapshot-mutations";
import {
  buildTimelineModel,
  createTimelineModelBuilder,
  type Entry,
  type TimelineModel,
  type TimelineModelInput,
} from "../../../src/lib/thread/thread-timeline-model";
import { appendEvent, modelInput, threadFixture } from "../thread-timeline-fixture";

/** Le fil rendu tel quel : ordre des entrées ET de leurs champs, comme `entrySignature`. */
function expectSameModel(actual: TimelineModel, expected: TimelineModel) {
  expect(JSON.stringify(actual.shown)).toBe(JSON.stringify(expected.shown));
  expect(actual).toStrictEqual(expected);
}

function entryRunId(entry: Entry): string | null {
  if (entry.kind === "event") return entry.event.runId;
  if (entry.kind === "gate") return entry.approval.runId ?? null;
  return entry.runId;
}

function agentMessage(cursor: number, runId: string, text: string): StoredProductEvent {
  return {
    cursor,
    runId,
    sequence: cursor,
    type: "agent.message",
    payload: { text },
    occurredAt: new Date(Date.parse("2026-09-01T00:00:00.000Z") + cursor * 1_000),
  } as StoredProductEvent;
}

/** Rejoue le dernier tour événement par événement, en comparant à chaque pas. */
function replayLastTurn(input: TimelineModelInput, tail: number) {
  const builder = createTimelineModelBuilder();
  const events = input.events;
  let current: TimelineModelInput = { ...input, events: events.slice(0, events.length - tail) };
  expectSameModel(builder(current), buildTimelineModel(current));
  for (const event of events.slice(events.length - tail)) {
    current = appendEvent(current, event);
    expectSameModel(builder(current), buildTimelineModel(current));
  }
  return { builder, current };
}

describe("modèle incrémental du fil", () => {
  test("les tableaux d'événements issus du patch SSE (lien d'origine, sans comparaison élément par élément) donnent le même modèle qu'une reconstruction", () => {
    const base = modelInput(threadFixture({ turns: 3, liveLastTurn: true }));
    const live = base.events.at(-1)!;
    const builder = createTimelineModelBuilder();
    // Seuls `events` et `runs` comptent pour le patch : le reste du snapshot est opaque ici.
    let snapshot = { events: base.events, runs: base.runs, messages: base.messages, cursor: 0 } as unknown as ThreadSnapshot;
    expectSameModel(builder({ ...base, events: snapshot.events }), buildTimelineModel({ ...base, events: snapshot.events }));
    for (let step = 1; step <= 3; step += 1) {
      snapshot = applyProductEventToSnapshot(snapshot, agentMessage(live.cursor + step, live.runId, `delta ${step}`));
      const input = { ...base, events: snapshot.events, runs: snapshot.runs };
      expectSameModel(builder(input), buildTimelineModel(input));
    }
  });

  test("les reçus de métadonnées seuls ne créent ni ligne vide ni trail", () => {
    const input = modelInput(threadFixture({ turns: 3, liveLastTurn: false }));
    const cursor = Math.max(...input.events.map((event) => event.cursor)) + 1;
    const receipts: StoredProductEvent[] = [
      {
        cursor,
        sequence: 1,
        runId: "receipt-only-run",
        type: "message.admitted",
        payload: { messageId: "message-1" },
        occurredAt: new Date("2026-10-04T00:00:10.000Z"),
      },
      {
        cursor: cursor + 1,
        sequence: 2,
        runId: "receipt-only-run",
        type: "run.steering",
        payload: { status: "ambiguous", attemptId: "attempt-1" },
        occurredAt: new Date("2026-10-04T00:00:11.000Z"),
      },
    ];

    expect(buildTimelineModel({ ...input, events: [...input.events, ...receipts] }))
      .toStrictEqual(buildTimelineModel(input));
  });

  test("DM : même sortie que la reconstruction complète, après chaque événement du flux", () => {
    const input = modelInput(threadFixture({ turns: 40 }));
    replayLastTurn(input, 30);
  });

  test("salon : tours sans message, passes et auteurs par run", () => {
    const input = modelInput(threadFixture({ turns: 36, group: true }));
    replayLastTurn(input, 25);
  });

  test("un événement ne reconstruit que son run : les autres entrées gardent leur identité", () => {
    const input = modelInput(threadFixture({ turns: 30 }));
    const builder = createTimelineModelBuilder();
    const before = builder(input);
    const lastRunId = input.events.at(-1)!.runId;
    const delta = {
      ...input.events.at(-1)!,
      cursor: 10_000,
      sequence: 10_000,
      type: "agent.message",
      payload: { text: " encore" },
    } as StoredProductEvent;
    const after = builder(appendEvent(input, delta));
    const previous = new Map(before.shown.map((entry) => [entry.key, entry]));
    const reused = after.shown.filter((entry) => previous.get(entry.key) === entry);
    const rebuilt = after.shown.filter((entry) => previous.get(entry.key) !== entry);
    expect(reused.length).toBeGreaterThan(before.shown.length - 20);
    expect(rebuilt.length).toBeGreaterThan(0);
    for (const entry of rebuilt) {
      expect("runId" in entry ? entry.runId : entry.kind === "gate" ? entry.approval.runId : null).toBe(lastRunId);
    }
    expectSameModel(after, buildTimelineModel(appendEvent(input, delta)));
  });

  test("ajouter un événement ne reconstruit pas les entrées d'un autre run", () => {
    const input = modelInput(
      { events: [agentMessage(1, "a", "a"), agentMessage(2, "b", "b")], userInputs: [], messages: [], approvals: [], runs: [] },
      { running: false },
    );
    const builder = createTimelineModelBuilder();
    const before = builder(input);
    const next = appendEvent(input, agentMessage(3, "b", " encore"));
    const after = builder(next);
    expectSameModel(after, buildTimelineModel(next));
    const kept = before.shown.filter((entry) => entryRunId(entry) === "a");
    expect(kept.length).toBeGreaterThan(0);
    for (const entry of kept) {
      expect(after.shown.find((candidate) => candidate.key === entry.key)).toBe(entry);
    }
  });

  test("un reçu commité entre deux deltas provisionnels ne coupe pas la réponse", () => {
    // Ordre réel du flux : le premier delta part avant son commit (sans
    // curseur), le poller livre ensuite `message.admitted`, puis la jumelle
    // durable du delta, écartée comme doublon par `runId:sequence`.
    const provisional = (sequence: number, text: string) =>
      ({ ...agentMessage(sequence, "run", text), cursor: undefined }) as unknown as StoredProductEvent;
    const admitted = {
      cursor: 4143,
      runId: "run",
      sequence: 0,
      type: "message.admitted",
      payload: { messageId: "message-1" },
      occurredAt: new Date("2026-09-01T00:00:00.500Z"),
    } as StoredProductEvent;
    const builder = createTimelineModelBuilder();
    let input = modelInput(
      { events: [], userInputs: [], messages: [], approvals: [], runs: [] },
      { running: true },
    );
    for (const event of [provisional(1, "Ça"), admitted, provisional(2, " va bien")]) {
      input = appendEvent(input, event);
      const model = builder(input);
      expectSameModel(model, buildTimelineModel(input));
      const keys = model.shown.map((entry) => entry.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
    const answers = builder(input).shown.filter((entry) => entry.kind === "assistant");
    expect(answers.map((entry) => entry.text)).toEqual(["Ça va bien"]);
  });

  test("une page antérieure en préfixe ne reconstruit pas les runs déjà vus", () => {
    const older = [agentMessage(1, "a", "a1"), agentMessage(2, "a", "a2")];
    const tail = [agentMessage(3, "b", "b1"), agentMessage(4, "b", "b2")];
    const builder = createTimelineModelBuilder();
    const tailInput = modelInput(
      { events: tail, userInputs: [], messages: [], approvals: [], runs: [] },
      { running: false },
    );
    const before = builder(tailInput);
    const prepended = { ...tailInput, events: [...older, ...tail] };
    const after = builder(prepended);
    expectSameModel(after, buildTimelineModel(prepended));
    const kept = before.shown.filter((entry) => entryRunId(entry) === "b");
    expect(kept.length).toBeGreaterThan(0);
    for (const entry of kept) {
      expect(after.shown.find((candidate) => candidate.key === entry.key)).toBe(entry);
    }
  });

  test("messages relus (objets neufs, mêmes valeurs) : les blocs restent réutilisés", () => {
    const input = modelInput(threadFixture({ turns: 20 }));
    const builder = createTimelineModelBuilder();
    const before = builder(input);
    const relisted = {
      ...input,
      userInputs: input.userInputs.map((message) => ({ ...message, attachments: [...(message.attachments ?? [])] })),
      messages: [...input.messages],
    };
    const after = builder(relisted);
    expectSameModel(after, buildTimelineModel(relisted));
    expect(after.shown.every((entry, index) => entry === before.shown[index])).toBe(true);
  });

  test("changements hors flux : réaction, statut du run absorbant, autorisation répondue, auteur", () => {
    const fixture = threadFixture({ turns: 26 });
    const builder = createTimelineModelBuilder();
    let input = modelInput(fixture);
    expectSameModel(builder(input), buildTimelineModel(input));

    input = {
      ...input,
      messages: input.messages.map((message) =>
        message.id === "msg-5" ? { ...message, reactions: [{ emoji: "🎉", count: 1, reactedByMe: true }] } : message),
    };
    expectSameModel(builder(input), buildTimelineModel(input));

    // Le run absorbant passe de « completed » à « running » : l'étiquette du message absorbé change.
    input = { ...input, runs: input.runs.map((run) => (run.id === "run-11" ? { ...run, status: "running" as const } : run)) };
    expectSameModel(builder(input), buildTimelineModel(input));

    input = { ...input, approvals: input.approvals.slice(1) };
    expectSameModel(builder(input), buildTimelineModel(input));

    input = { ...input, defaultAuthor: { id: "bot-x", name: "X", slug: "x", face: null } };
    expectSameModel(builder(input), buildTimelineModel(input));

    input = { ...input, operatorUsername: "user", activeAskUserRunId: "run-7", running: false };
    expectSameModel(builder(input), buildTimelineModel(input));

    input = { ...input, toolFallbackLabel: "tool" };
    expectSameModel(builder(input), buildTimelineModel(input));
  });

  test("snapshot relu (événements clonés), tronqué, puis vidé", () => {
    const fixture = threadFixture({ turns: 18 });
    const builder = createTimelineModelBuilder();
    let input = modelInput(fixture);
    expectSameModel(builder(input), buildTimelineModel(input));

    input = { ...input, events: structuredClone(input.events) };
    expectSameModel(builder(input), buildTimelineModel(input));

    input = { ...input, events: input.events.slice(0, 120) };
    expectSameModel(builder(input), buildTimelineModel(input));

    input = { ...input, events: [...input.events.slice(0, 40), ...input.events.slice(41)] };
    expectSameModel(builder(input), buildTimelineModel(input));

    input = { ...input, events: [], userInputs: [], messages: [], approvals: [], runs: [] };
    expectSameModel(builder(input), buildTimelineModel(input));
  });

  test("plans et recherches de runs sans ancre : posés en fin de fil, dans l'ordre global", () => {
    const at = (second: number) => new Date(Date.parse("2026-09-01T00:00:00.000Z") + second * 1_000);
    const plan = (id: string) => ({ steps: [{ id, content: id, status: "pending" }] });
    const search = (id: string) => ({ queries: [{ id, query: id, sources: [], error: null, resultCount: null }] });
    const events = [
      { cursor: 1, runId: "b", sequence: 1, type: "raw", payload: { agentPlan: plan("b1") }, occurredAt: at(3) },
      { cursor: 2, runId: "a", sequence: 1, type: "raw", payload: { webSearch: search("a1") }, occurredAt: at(1) },
      { cursor: 3, runId: "a", sequence: 2, type: "raw", payload: { agentPlan: plan("a1") }, occurredAt: at(2) },
      { cursor: 4, runId: "b", sequence: 2, type: "raw", payload: { webSearch: search("b1") }, occurredAt: at(4) },
    ] as StoredProductEvent[];
    const input = modelInput({ events, userInputs: [], messages: [], approvals: [], runs: [] }, { running: false });
    const model = createTimelineModelBuilder()(input);
    expectSameModel(model, buildTimelineModel(input));
    expect(model.shown.map((entry) => entry.key)).toEqual(["plan:b", "plan:a", "search:a", "search:b"]);
  });

  test("une même autorisation ancrée dans deux runs : la première gagne, comme le fil complet", () => {
    const fixture = threadFixture({ turns: 10, liveLastTurn: false });
    const [approval] = fixture.approvals;
    expect(approval).toBeDefined();
    const replay = {
      cursor: 99_999,
      runId: "run-8",
      sequence: 99_999,
      type: "approval.requested",
      payload: { approvalRequestId: approval!.id },
      occurredAt: new Date("2026-09-01T09:00:00.000Z"),
    } as StoredProductEvent;
    const builder = createTimelineModelBuilder();
    const input = modelInput(fixture);
    builder(input);
    const replayed = appendEvent(input, replay);
    const model = builder(replayed);
    expectSameModel(model, buildTimelineModel(replayed));
    expect(model.shown.filter((entry) =>
      entry.kind === "gate" ? entry.approval.id === approval!.id
        : entry.kind === "tools" && entry.approvals.some((candidate) => candidate.id === approval!.id))).toHaveLength(1);
  });

  test("la puce d'un fichier produit se pose sur la dernière bulle du tour", () => {
    const fixture = threadFixture({ turns: 1, liveLastTurn: false, toolsPerTurn: 1 });
    const assistant = fixture.messages.find((message) => message.role === "assistant");
    expect(assistant).toBeDefined();
    assistant!.content = [
      ...assistant!.content,
      {
        type: "attachment",
        id: "file-1",
        name: "ohb-artifact-probe.html",
        contentType: "text/html",
        kind: "document",
        bytes: 59,
      },
    ];
    const shown = buildTimelineModel(modelInput(fixture, { running: false })).shown;
    const bubbles = shown.filter((entry) => entry.kind === "assistant");
    expect(bubbles.length).toBeGreaterThan(1);
    expect(bubbles.slice(0, -1).every((entry) => entry.kind === "assistant" && !entry.attachments)).toBe(true);
    const last = bubbles[bubbles.length - 1];
    expect(last?.kind === "assistant" && last.attachments?.map((item) => item.name)).toEqual([
      "ohb-artifact-probe.html",
    ]);
  });

  test("la ligne MEDIA: d'un fichier joint sort du texte diffusé ; un fichier absent garde son nom", () => {
    const fixture = threadFixture({ turns: 1, liveLastTurn: false });
    const assistant = fixture.messages.find((message) => message.role === "assistant")!;
    const lastText = [...fixture.events].reverse().find((event) => event.type === "agent.message" && event.runId === assistant.runId)!;
    lastText.payload = { text: "Voici :\n\nMEDIA:/workspace/vert_ok.png\n\nMEDIA:/tmp/out/perdu.png\n\nFin." };
    assistant.content = [...assistant.content, { type: "attachment", id: "file-1", name: "vert_ok.png", contentType: "image/png", kind: "image", bytes: 4157 }];
    const bubbles = buildTimelineModel(modelInput(fixture, { running: false })).shown.filter((entry) => entry.kind === "assistant");
    const text = bubbles.map((entry) => (entry.kind === "assistant" ? entry.text : "")).join("\n");
    expect(text).not.toContain("MEDIA:");
    expect(text).toContain("`perdu.png`");
    expect(text).not.toContain("vert_ok.png");
  });
});

