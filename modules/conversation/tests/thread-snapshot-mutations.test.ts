import { describe, expect, test } from "bun:test";
import type { BotDto, GroupDto, RosterDto, ThreadSnapshot } from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import {
  applyProductEventToRoster,
  applyProductEventToSnapshot,
  applySendAcceptedToRoster,
  applySendAcceptedToSnapshot,
  eventsAppendedFrom,
  findRosterThread,
  isEventReflectedInRosterRow,
  isStaleRosterEvent,
  markRosterThreadRead,
  snapshotRefreshAfterEvent,
  statusFromEvent,
  TERMINAL_COMPLETION_VERSION,
  type RosterEvent,
} from "../src/domain/thread-snapshot-mutations";

function bot(overrides: Partial<BotDto> & Pick<BotDto, "id" | "threadId" | "lastActivityAt">): BotDto {
  return {
    name: overrides.id,
    slug: overrides.id,
    description: null,
    instructions: "",
    model: null,
    reasoningEffort: null,
    sectionId: "section-1",
    position: 0,
    pinned: false,
    face: null,
    voiceId: null,
    hermesProfile: null,
    isolation: "shared" as BotDto["isolation"],
    hasOwnRuntime: false,
    runtimeName: null,
    awaitingApproval: false,
    running: false,
    unread: false,
    preview: null,
    archivedAt: null,
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    lastRunAt: null,
    ...overrides,
  };
}

function group(overrides: Partial<GroupDto> & Pick<GroupDto, "id" | "threadId" | "lastActivityAt">): GroupDto {
  return {
    name: overrides.id,
    instructions: "",
    defaultResponder: { kind: "everyone" },
    members: [],
    sectionId: "section-1",
    position: 0,
    needsYou: false,
    awaitingApproval: false,
    running: true,
    preview: null,
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    ...overrides,
  };
}

function rosterEvent(overrides: Partial<RosterEvent> & Pick<RosterEvent, "threadId" | "type">): RosterEvent {
  return {
    cursor: 50,
    runId: "run-1",
    sequence: 3,
    payload: {},
    occurredAt: "2026-08-25T10:00:00.000Z",
    ...overrides,
  };
}

function completedWithText(threadId: string, text: string, extra: Partial<RosterEvent> = {}): RosterEvent {
  return rosterEvent({
    threadId,
    type: "run.completed",
    payload: {
      completion: {
        version: TERMINAL_COMPLETION_VERSION,
        messages: [{
          id: "message-9",
          role: "assistant",
          content: [{ type: "text", text }],
          createdAt: "2026-08-25T10:00:00.000Z",
          runId: "run-1",
        }],
        run: {
          id: "run-1", status: "completed", output: null, usage: null, error: null,
          endedAt: "2026-08-25T10:00:00.000Z", lastEventAt: "2026-08-25T10:00:00.000Z",
        },
        workflow: null,
      },
    },
    ...extra,
  });
}

const roster: RosterDto = {
  sections: [],
  bots: [
    bot({ id: "bot-a", threadId: "thread-a", lastActivityAt: "2026-08-25T09:00:00.000Z", position: 0 }),
    bot({ id: "bot-b", threadId: "thread-b", lastActivityAt: "2026-08-25T08:00:00.000Z", position: 1 }),
  ],
  groups: [group({ id: "group-1", threadId: "thread-g", lastActivityAt: "2026-08-25T07:00:00.000Z" })],
};

describe("snapshotRefreshAfterEvent", () => {
  const terminal = {
    cursor: 10, runId: "run-1", sequence: 1, type: "run.completed", payload: {}, occurredAt: new Date(),
  } as StoredProductEvent;

  test("un événement déjà dans le snapshot n'oblige à rien relire", () => {
    expect(snapshotRefreshAfterEvent({
      event: terminal, hasSnapshot: true, unknownRun: false, snapshotCursor: 10,
    })).toEqual({ thread: false, roster: false });
    expect(snapshotRefreshAfterEvent({
      event: terminal, hasSnapshot: true, unknownRun: true, snapshotCursor: 12,
    })).toEqual({ thread: false, roster: false });
  });

  test("le roster ne se relit que pour un run inconnu ; le fil garde ses règles", () => {
    expect(snapshotRefreshAfterEvent({
      event: terminal, hasSnapshot: true, unknownRun: false, snapshotCursor: 9,
    })).toEqual({ thread: true, roster: false });
    expect(snapshotRefreshAfterEvent({
      event: terminal, hasSnapshot: true, unknownRun: true, snapshotCursor: 9,
    })).toEqual({ thread: true, roster: true });
    expect(snapshotRefreshAfterEvent({
      event: { ...terminal, type: "bot.message" }, hasSnapshot: true, unknownRun: false,
    })).toEqual({ thread: true, roster: false });
  });

  test("les reçus frais relisent le fil mais un curseur déjà vu ne déclenche rien", () => {
    for (const type of ["message.admitted", "run.steering"] as const) {
      const receipt: StoredProductEvent = {
        ...terminal,
        type,
        payload: type === "run.steering" ? { status: "ambiguous", attemptId: "attempt-1" } : { messageId: "message-1" },
      };
      expect(statusFromEvent(receipt)).toBeNull();
      expect(snapshotRefreshAfterEvent({
        event: receipt, hasSnapshot: true, unknownRun: false, snapshotCursor: 9,
      })).toEqual({ thread: true, roster: false });
      expect(snapshotRefreshAfterEvent({
        event: receipt, hasSnapshot: true, unknownRun: false, snapshotCursor: 10,
      })).toEqual({ thread: false, roster: false });
    }
  });

  test("un run déjà connu ne relit pas l'historique à chaque événement du tour", () => {
    for (const type of ["agent.message", "agent.reasoning", "tool.call", "tool.result"] as const) {
      expect(snapshotRefreshAfterEvent({
        event: { ...terminal, type, payload: { text: "live" } },
        hasSnapshot: true,
        unknownRun: false,
        snapshotCursor: 9,
      })).toEqual({ thread: false, roster: false });
    }
    expect(snapshotRefreshAfterEvent({
      event: { ...terminal, type: "agent.message", payload: { text: "live" } },
      hasSnapshot: true,
      unknownRun: true,
      snapshotCursor: 9,
    })).toEqual({ thread: true, roster: true });
  });

  test("un steer accepté relit le run FIFO soldé hors de l'événement", () => {
    const steered = {
      ...terminal,
      type: "raw",
      payload: { event: "run.steered", accepted: true },
    } as StoredProductEvent;
    expect(snapshotRefreshAfterEvent({
      event: steered, hasSnapshot: true, unknownRun: false, snapshotCursor: 9,
    })).toEqual({ thread: true, roster: false });
    expect(snapshotRefreshAfterEvent({
      event: { ...steered, payload: { event: "run.steered", accepted: false } },
      hasSnapshot: true,
      unknownRun: false,
      snapshotCursor: 9,
    })).toEqual({ thread: false, roster: false });
  });
});

describe("applyProductEventToRoster", () => {
  test("un fil inconnu du roster ou un événement hors fil rend le MÊME objet", () => {
    expect(applyProductEventToRoster(roster, rosterEvent({ threadId: "thread-zz", type: "run.completed" }))).toBe(roster);
    expect(applyProductEventToRoster(roster, rosterEvent({ threadId: null, type: "run.completed" }))).toBe(roster);
  });

  test("les reçus avancent le curseur sans toucher la ligne ou sa pastille", () => {
    const withCursor = { ...roster, cursor: 50 };
    for (const type of ["message.admitted", "run.steering"] as const) {
      const event = rosterEvent({
        threadId: "thread-a",
        cursor: 51,
        type,
        payload: type === "run.steering" ? { status: "ambiguous", attemptId: "attempt-1" } : { messageId: "message-1" },
      });
      const next = applyProductEventToRoster(withCursor, event);
      expect(next.cursor).toBe(51);
      expect(next.bots[0]).toBe(withCursor.bots[0]);
      expect(next.bots[0]).toMatchObject({ running: false, unread: false, preview: null });
    }
  });

  test("un run terminé dans un autre fil : aperçu, horodatage, non-lu, pastille éteinte, ligne remontée", () => {
    const next = applyProductEventToRoster(
      roster,
      completedWithText("thread-b", "Voici la réponse.".padEnd(200, "x")),
      { openThreadId: "thread-a" },
    );
    expect(next).not.toBe(roster);
    expect(next.bots.map((row) => row.id)).toEqual(["bot-b", "bot-a"]);
    const patched = next.bots[0]!;
    expect(patched.lastActivityAt).toBe("2026-08-25T10:00:00.000Z");
    expect(patched.preview).toHaveLength(160);
    expect(patched.preview?.startsWith("Voici la réponse.")).toBe(true);
    expect(patched.unread).toBe(true);
    expect(patched.running).toBe(false);
    expect(patched.awaitingApproval).toBe(false);
    // Les autres lignes et les salons sont les objets d'origine.
    expect(next.bots[1]).toBe(roster.bots[0]);
    expect(next.groups).toBe(roster.groups);
  });

  test("le fil ouvert ne passe jamais non-lu, et un aperçu absent reste tel quel", () => {
    const next = applyProductEventToRoster(
      roster,
      rosterEvent({ threadId: "thread-a", type: "run.completed" }),
      { openThreadId: "thread-a" },
    );
    const patched = next.bots[0]!;
    expect(patched.id).toBe("bot-a");
    expect(patched.unread).toBe(false);
    expect(patched.preview).toBeNull();
    expect(patched.lastActivityAt).toBe("2026-08-25T10:00:00.000Z");
  });

  test("un événement rejoué, daté à ou avant l'activité de la ligne, ne touche à rien", () => {
    // Ni horodatage reculé, ni `running` rallumé, ni non-lu sur un fil déjà lu.
    for (const occurredAt of ["2026-08-25T01:00:00.000Z", "2026-08-25T09:00:00.000Z"]) {
      expect(applyProductEventToRoster(
        roster,
        rosterEvent({ threadId: "thread-a", type: "agent.message", occurredAt }),
        { openThreadId: "thread-b" },
      )).toBe(roster);
      expect(applyProductEventToRoster(
        roster,
        completedWithText("thread-a", "déjà lu", { occurredAt }),
        { openThreadId: "thread-b" },
      )).toBe(roster);
    }
    expect(isEventReflectedInRosterRow(
      { lastActivityAt: "2026-08-25T09:00:00.000Z" }, { occurredAt: "2026-08-25T09:00:00.001Z" },
    )).toBe(false);
    expect(isEventReflectedInRosterRow(
      { lastActivityAt: "2026-08-25T09:00:00.000Z" }, { occurredAt: new Date("2026-08-25T09:00:00.000Z") },
    )).toBe(true);
    expect(isEventReflectedInRosterRow({ lastActivityAt: "n'importe quoi" }, { occurredAt: "2026-08-25T09:00:00.000Z" })).toBe(false);
  });

  test("un événement live plus récent que la ligne allume la pastille d'exécution", () => {
    const next = applyProductEventToRoster(
      roster,
      rosterEvent({ threadId: "thread-a", type: "agent.message", occurredAt: "2026-08-25T09:00:01.000Z" }),
    );
    expect(next.bots[0]!.running).toBe(true);
    expect(next.bots[0]!.lastActivityAt).toBe("2026-08-25T09:00:01.000Z");
  });

  test("un enrichissement après la fin ne rallume pas le bot, une activité réelle oui", () => {
    const completed = applyProductEventToRoster(
      { ...roster, bots: [bot({ id: "bot-a", threadId: "thread-a", lastActivityAt: "2026-08-25T09:00:00.000Z", running: true })] },
      completedWithText("thread-a", "Terminé", { cursor: 51 }),
    );
    expect(completed.bots[0]!.running).toBe(false);

    for (const type of ["tool.result.attached", "approval.responded", "bot.message", "system.notice", "raw"] as const) {
      const afterCompletion = applyProductEventToRoster(
        completed,
        rosterEvent({ threadId: "thread-a", type, cursor: 52, occurredAt: "2026-08-25T10:00:01.000Z" }),
      );
      expect(afterCompletion.bots[0]!.running).toBe(false);
    }

    const active = applyProductEventToRoster(
      completed,
      rosterEvent({ threadId: "thread-a", type: "tool.call", cursor: 52, occurredAt: "2026-08-25T10:00:01.000Z" }),
    );
    expect(active.bots[0]!.running).toBe(true);
  });

  test("une demande d'approbation allume la pastille, la réponse l'éteint", () => {
    const asked = applyProductEventToRoster(roster, rosterEvent({ threadId: "thread-a", type: "approval.requested" }));
    expect(asked.bots[0]!.awaitingApproval).toBe(true);
    expect(asked.bots[0]!.running).toBe(true);
    const answered = applyProductEventToRoster(
      asked,
      rosterEvent({ threadId: "thread-a", type: "approval.responded", cursor: 51, occurredAt: "2026-08-25T10:00:01.000Z" }),
    );
    expect(answered.bots[0]!.awaitingApproval).toBe(false);
    expect(answered.bots[0]!.running).toBe(true);
  });

  test("une gate en revue automatique n'allume pas la pastille (PERM2-7)", () => {
    const reviewing = applyProductEventToRoster(roster, rosterEvent({ threadId: "thread-a", type: "approval.requested", payload: { reviewing: true } }));
    expect(reviewing.bots[0]!.awaitingApproval).not.toBe(true);
    expect(reviewing.bots[0]!.running).toBe(true);
  });

  test("un bot.message dans un salon patche le salon : texte, non-lu, ordre conservé", () => {
    const next = applyProductEventToRoster(
      roster,
      rosterEvent({ threadId: "thread-g", type: "bot.message", payload: { text: "Salut du bot B", ok: true } }),
      { openThreadId: "thread-a" },
    );
    expect(next.bots).toBe(roster.bots);
    expect(next.groups?.[0]?.preview).toBe("Salut du bot B");
    expect(next.groups?.[0]?.unread).toBe(true);
    expect(next.groups?.[0]?.running).toBe(true);
  });

  test("un tour de salon qui passe la main garde le salon en cours, une notice ne le rallume pas", () => {
    const handoff = completedWithText("thread-g", "Yo !");
    const completion = handoff.payload.completion as Record<string, unknown>;
    const continuing = applyProductEventToRoster(roster, {
      ...handoff,
      payload: { completion: { ...completion, workflow: { id: "wf-1", status: "running", updatedAt: "2026-08-25T10:00:00.000Z" } } },
    }, { openThreadId: "thread-g" });
    expect(continuing.groups?.[0]?.running).toBe(true);
    const settled = applyProductEventToRoster(roster, handoff, { openThreadId: "thread-g" });
    expect(settled.groups?.[0]?.running).toBe(false);
    const notice = applyProductEventToRoster(
      settled,
      rosterEvent({ threadId: "thread-g", type: "system.notice", cursor: 51, payload: { kind: "group.pass", message: "x" } }),
      { openThreadId: "thread-g" },
    );
    expect(notice.groups?.[0]?.running).toBe(false);
  });

  test("rien ne change : même objet", () => {
    const settled: RosterDto = {
      ...roster,
      bots: [bot({
        id: "bot-a", threadId: "thread-a", lastActivityAt: "2026-08-25T10:00:00.000Z",
        running: false, awaitingApproval: false, unread: true,
      })],
    };
    expect(applyProductEventToRoster(
      settled,
      rosterEvent({ threadId: "thread-a", type: "run.completed" }),
      { openThreadId: "thread-b" },
    )).toBe(settled);
  });

  test("un roster épinglé garde les épinglés en tête quand une ligne remonte", () => {
    const pinnedFirst: RosterDto = {
      ...roster,
      bots: [
        bot({ id: "bot-pin", threadId: "thread-pin", lastActivityAt: "2026-08-25T01:00:00.000Z", pinned: true, position: 0 }),
        bot({ id: "bot-a", threadId: "thread-a", lastActivityAt: "2026-08-25T09:00:00.000Z", position: 1 }),
        bot({ id: "bot-b", threadId: "thread-b", lastActivityAt: "2026-08-25T08:00:00.000Z", position: 2 }),
      ],
    };
    const next = applyProductEventToRoster(pinnedFirst, completedWithText("thread-b", "ok"));
    expect(next.bots.map((row) => row.id)).toEqual(["bot-pin", "bot-b", "bot-a"]);
  });

  test("un roster trié autrement n'est pas réordonné", () => {
    const custom: RosterDto = { ...roster, bots: [roster.bots[1]!, roster.bots[0]!] };
    const next = applyProductEventToRoster(custom, completedWithText("thread-a", "ok"));
    expect(next.bots.map((row) => row.id)).toEqual(["bot-b", "bot-a"]);
  });
});

describe("isStaleRosterEvent (par curseur)", () => {
  test("curseur ≤ celui du roster : périmé ; supérieur : non ; sans curseur (API antérieure) : jamais", () => {
    expect(isStaleRosterEvent({ cursor: 50 }, { cursor: 50 })).toBe(true);
    expect(isStaleRosterEvent({ cursor: 49 }, { cursor: 50 })).toBe(true);
    expect(isStaleRosterEvent({ cursor: 51 }, { cursor: 50 })).toBe(false);
    expect(isStaleRosterEvent({ cursor: 1 }, {})).toBe(false);
    expect(isStaleRosterEvent({ cursor: 1 }, undefined)).toBe(false);
  });

  test("un rejeu sous le curseur du roster rend le même objet, même daté après la ligne", () => {
    const withCursor: RosterDto = { ...roster, cursor: 100 };
    expect(applyProductEventToRoster(
      withCursor,
      completedWithText("thread-b", "rejoué", { cursor: 100, occurredAt: "2026-08-25T12:00:00.000Z" }),
      { openThreadId: "thread-a" },
    )).toBe(withCursor);
  });

  test("scénario A/B : run.completed capturé AVANT un delta mais commité APRÈS → patché, curseur avancé", () => {
    // B a émis un delta capturé à T+50 (curseur 101) ; le roster l'a déjà
    // (cursor 101, ligne B à T+50). Le run.completed de A, capturé à T (avant
    // le delta de B) mais commité après (curseur 102), doit quand même
    // conclure A : son curseur est au-dessus, sa date est sans importance.
    const withCursor: RosterDto = {
      ...roster,
      cursor: 101,
      bots: [
        bot({ id: "bot-a", threadId: "thread-a", lastActivityAt: "2026-08-25T09:00:00.000Z", running: true, position: 0 }),
        bot({ id: "bot-b", threadId: "thread-b", lastActivityAt: "2026-08-25T10:00:00.050Z", running: true, position: 1 }),
      ],
    };
    const next = applyProductEventToRoster(
      withCursor,
      completedWithText("thread-a", "fini", { cursor: 102, occurredAt: "2026-08-25T10:00:00.000Z" }),
      { openThreadId: "thread-b" },
    );
    expect(next).not.toBe(withCursor);
    expect(next.cursor).toBe(102);
    const rowA = next.bots.find((row) => row.id === "bot-a")!;
    expect(rowA.running).toBe(false);
    expect(rowA.unread).toBe(true);
    expect(rowA.preview).toBe("fini");
    // Un roster sans curseur reste sans curseur.
    expect(applyProductEventToRoster(roster, completedWithText("thread-b", "ok")).cursor).toBeUndefined();
  });
});

describe("markRosterThreadRead / findRosterThread", () => {
  const unreadRoster: RosterDto = {
    ...roster,
    bots: [bot({ id: "bot-a", threadId: "thread-a", lastActivityAt: "2026-08-25T09:00:00.000Z", unread: true })],
    groups: [group({ id: "group-1", threadId: "thread-g", lastActivityAt: "2026-08-25T07:00:00.000Z", unread: true })],
  };

  test("passe la ligne du fil en lu, bot comme salon, sans toucher au reste ni au curseur", () => {
    const bots = markRosterThreadRead({ ...unreadRoster, cursor: 77 }, "thread-a");
    expect(bots.bots[0]!.unread).toBe(false);
    expect(bots.cursor).toBe(77);
    expect(bots.groups).toBe(unreadRoster.groups);
    const groups = markRosterThreadRead(unreadRoster, "thread-g");
    expect(groups.groups?.[0]?.unread).toBe(false);
    expect(groups.bots).toBe(unreadRoster.bots);
  });

  test("ligne absente ou déjà lue : même objet", () => {
    expect(markRosterThreadRead(unreadRoster, "thread-zz")).toBe(unreadRoster);
    const read = markRosterThreadRead(unreadRoster, "thread-a");
    expect(markRosterThreadRead(read, "thread-a")).toBe(read);
  });

  test("findRosterThread retrouve bot puis salon, sinon undefined", () => {
    expect(findRosterThread(unreadRoster, "thread-a")?.id).toBe("bot-a");
    expect(findRosterThread(unreadRoster, "thread-g")?.id).toBe("group-1");
    expect(findRosterThread(unreadRoster, "thread-zz")).toBeUndefined();
  });
});

describe("applyProductEventToSnapshot : partage structurel", () => {
  const runA = {
    id: "run-a", status: "running" as const, botId: "bot-a", input: "a", output: null, usage: null,
    error: null, hermesResponseId: null, model: null, runtimeSession: null,
    createdAt: "2026-08-25T09:00:00.000Z", startedAt: "2026-08-25T09:00:00.000Z", endedAt: null,
    lastEventAt: "2026-08-25T09:00:00.000Z", workflowId: null, stepIndex: 0, stepKind: "root" as const,
    stackDepth: 0, completionKind: null, recoveryState: null,
  };
  const runB = { ...runA, id: "run-b" };
  const existingEvent: StoredProductEvent = {
    cursor: 1, sequence: 1, runId: "run-b", type: "tool.call", payload: {}, occurredAt: new Date("2026-08-25T09:00:00.000Z"),
  };
  const baseSnapshot: ThreadSnapshot = {
    id: "thread-a", botId: "bot-a", title: "A", botName: "A", instructions: "", model: "", effectiveModel: "",
    createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T09:00:00.000Z",
    messages: [], runs: [runA, runB], events: [existingEvent], workflows: [], cursor: 1, truncated: false,
  };

  test("un événement pour un run ne recrée que ce run ; les autres runs, les messages et les événements connus gardent leur référence", () => {
    const event: StoredProductEvent = {
      cursor: 2, sequence: 2, runId: "run-a", type: "tool.call",
      payload: { tool: "skill_view" }, occurredAt: new Date("2026-08-25T09:00:01.000Z"),
    };
    const next = applyProductEventToSnapshot(baseSnapshot, event);
    expect(next).not.toBe(baseSnapshot);
    expect(next.runs.find((run) => run.id === "run-b")).toBe(runB);
    expect(next.runs.find((run) => run.id === "run-a")).not.toBe(runA);
    expect(next.events[0]).toBe(existingEvent);
    expect(next.events[1]).toBe(event);
    expect(next.messages).toBe(baseSnapshot.messages);
  });

  test("un événement déjà connu (même runId + sequence) rend le MÊME snapshot", () => {
    const duplicate: StoredProductEvent = { ...existingEvent };
    expect(applyProductEventToSnapshot(baseSnapshot, duplicate)).toBe(baseSnapshot);
  });

  test("run.error pose le code stable sur le run : l'alerte « modèle indisponible » n'attend pas un rechargement", () => {
    const error = (sequence: number, payload: Record<string, unknown>): StoredProductEvent => ({
      cursor: 10 + sequence, sequence, runId: "run-a", type: "run.error",
      payload, occurredAt: new Date("2026-08-25T09:00:02.000Z"),
    });
    const coded = applyProductEventToSnapshot(baseSnapshot, error(2, { message: "HTTP 400", errorCode: "MODEL_UNAVAILABLE" }));
    const failed = coded.runs.find((run) => run.id === "run-a")!;
    expect(failed.status).toBe("failed");
    expect(failed.errorCode).toBe("MODEL_UNAVAILABLE");
    // Sans code dans la charge, le run n'en invente pas.
    const plain = applyProductEventToSnapshot(baseSnapshot, error(3, { message: "boom" }));
    expect(plain.runs.find((run) => run.id === "run-a")!.errorCode).toBeUndefined();
  });

  test("l'ajout d'un événement garde les objets devant, ne mute pas l'ancien tableau et pose le lien d'origine", () => {
    const first: StoredProductEvent = {
      cursor: 2, sequence: 2, runId: "run-a", type: "tool.call", payload: {}, occurredAt: new Date("2026-08-25T09:00:01.000Z"),
    };
    const second: StoredProductEvent = { ...first, cursor: 3, sequence: 3 };
    const once = applyProductEventToSnapshot(baseSnapshot, first);
    const twice = applyProductEventToSnapshot(once, second);
    expect(baseSnapshot.events).toEqual([existingEvent]);
    expect(once.events).not.toBe(baseSnapshot.events);
    expect(twice.events).toHaveLength(3);
    expect(twice.events[0]).toBe(existingEvent);
    expect(twice.events[1]).toBe(first);
    expect(twice.events[2]).toBe(second);
    expect(eventsAppendedFrom(once.events)).toBe(baseSnapshot.events);
    expect(eventsAppendedFrom(twice.events)).toBe(once.events);
    // Un tableau qui ne sort pas d'un patch SSE n'a pas de lien.
    expect(eventsAppendedFrom(baseSnapshot.events)).toBeUndefined();
    expect(eventsAppendedFrom([...twice.events])).toBeUndefined();
  });

  test("une trame sans curseur n'empoisonne pas le curseur du snapshot", () => {
    const live = {
      ...existingEvent,
      sequence: 9,
      runId: "run-a",
      cursor: undefined,
    } as unknown as StoredProductEvent;
    const next = applyProductEventToSnapshot(baseSnapshot, live);
    expect(next.cursor).toBe(baseSnapshot.cursor);
    expect(next.events).toHaveLength(2);
  });
});

describe("applySendAcceptedToSnapshot / roster", () => {
  const snapshot: ThreadSnapshot = {
    id: "thread-a",
    botId: "bot-a",
    title: "A",
    botName: "A",
    instructions: "",
    model: "",
    effectiveModel: "",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T09:00:00.000Z",
    messages: [],
    runs: [],
    events: [],
    workflows: [],
    cursor: 10,
    truncated: false,
  };
  const message = {
    id: "msg-1",
    role: "user" as const,
    content: [{ type: "text" as const, text: "sonde latence" }],
    runId: "run-new",
    createdAt: "2026-08-25T10:00:00.000Z",
    authorBot: null,
    replyTo: null,
    reactions: [],
  };
  const run = {
    id: "run-new",
    status: "queued" as const,
    botId: "bot-a",
    input: "sonde latence",
    output: null,
    usage: null,
    error: null,
    hermesResponseId: null,
    model: null,
    runtimeSession: null,
    createdAt: "2026-08-25T10:00:00.000Z",
    startedAt: null,
    endedAt: null,
    lastEventAt: null,
    workflowId: "wf-new",
    stepIndex: 0,
    stepKind: "root" as const,
    stackDepth: 0,
    completionKind: null,
    recoveryState: null,
  };

  test("un run queued passe running au premier événement d'exécution, pas sur une notice", () => {
    const queued = { ...snapshot, runs: [run] };
    const event = (sequence: number, type: StoredProductEvent["type"]): StoredProductEvent => ({
      cursor: 10 + sequence, sequence, runId: "run-new", type,
      payload: type === "system.notice" ? { kind: "info", message: "note" } : { tool: "skill_view" },
      occurredAt: new Date("2026-08-25T10:00:01.000Z"),
    });
    const noticed = applyProductEventToSnapshot(queued, event(1, "system.notice"));
    expect(noticed.runs[0]?.status).toBe("queued");
    const executing = applyProductEventToSnapshot(noticed, event(2, "tool.call"));
    expect(executing.runs[0]?.status).toBe("running");
    expect(executing.runs[0]?.startedAt).not.toBeNull();
  });

  test("les reçus n'avancent jamais pending, starting ou queued vers running", () => {
    for (const status of ["pending", "starting", "queued"] as const) {
      for (const type of ["message.admitted", "run.steering"] as const) {
        const sourceRun: ThreadSnapshot["runs"][number] = { ...run, status };
        const queued: ThreadSnapshot = { ...snapshot, runs: [sourceRun], cursor: 10 };
        const receipt: StoredProductEvent = {
          cursor: 11,
          sequence: 1,
          runId: "run-new",
          type,
          payload: type === "run.steering" ? { status: "ambiguous", attemptId: "attempt-1" } : { messageId: "message-1" },
          occurredAt: new Date("2026-08-25T10:00:01.000Z"),
        };
        const next = applyProductEventToSnapshot(queued, receipt);
        expect(next.cursor).toBe(11);
        expect(next.runs[0]?.status).toBe(status);
        expect(next.runs[0]?.startedAt).toBeNull();
        expect(next.events).toEqual([receipt]);
      }
    }
  });

  test("sans message : même snapshot (l'appelant relit)", () => {
    expect(applySendAcceptedToSnapshot(snapshot, {
      runId: "run-new", workflowId: "wf-new", status: "queued",
    })).toBe(snapshot);
  });

  test("ajoute le message et le run queued, pas de doublon au second passage", () => {
    const next = applySendAcceptedToSnapshot(snapshot, {
      runId: "run-new", workflowId: "wf-new", status: "queued", message, run,
    });
    expect(next.messages.map((item) => item.id)).toEqual(["msg-1"]);
    expect(next.runs.map((item) => item.id)).toEqual(["run-new"]);
    expect(next.updatedAt).toBe("2026-08-25T10:00:00.000Z");
    expect(applySendAcceptedToSnapshot(next, {
      runId: "run-new", workflowId: "wf-new", status: "queued", message, run,
    })).toBe(next);
  });

  test("un 202 en retard conserve le snapshot déjà conclu par le SSE", () => {
    const terminalRun = {
      ...run,
      status: "completed" as const,
      output: "réponse SSE",
      endedAt: "2026-08-25T10:00:02.000Z",
      lastEventAt: "2026-08-25T10:00:02.000Z",
    };
    const terminalMessage = {
      ...message,
      id: "msg-answer",
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "réponse SSE" }],
      createdAt: "2026-08-25T10:00:01.000Z",
    };
    const current = {
      ...snapshot,
      updatedAt: "2026-08-25T10:00:02.000Z",
      messages: [terminalMessage],
      runs: [terminalRun],
      events: [{
        cursor: 20,
        sequence: 1,
        runId: "run-new",
        type: "run.completed" as const,
        payload: {},
        occurredAt: new Date("2026-08-25T10:00:02.000Z"),
      }],
    };
    const next = applySendAcceptedToSnapshot(current, {
      runId: "run-new", workflowId: "wf-new", status: "queued", message, run,
      workflow: {
        id: "wf-new", kind: "dm", status: "queued", rootRunId: "run-new", rootBotId: "bot-a",
        usedSteps: 1, maxSteps: 5, usedHandoffs: 0, maxHandoffs: 2, usedTokens: 0, tokenBudget: 1000,
        deadlineAt: "2026-08-25T10:05:00.000Z", errorCode: null, errorMessage: null,
        recoveryState: null, createdAt: "2026-08-25T10:00:00.000Z", updatedAt: "2026-08-25T10:00:00.000Z",
      },
    });

    expect(next).not.toBe(current);
    expect(next.messages.map((item) => item.id)).toEqual(["msg-1", "msg-answer"]);
    expect(next.runs[0]).toBe(terminalRun);
    expect(next.runs[0]?.status).toBe("completed");
    expect(next.workflows).toEqual([]);
    expect(next.updatedAt).toBe("2026-08-25T10:00:02.000Z");
  });

  test("ne remplace aucun état terminal du run superseded", () => {
    const statuses = ["completed", "failed", "cancelled"] as const;
    for (const status of statuses) {
      const terminalRun = {
        ...run,
        id: `run-old-${status}`,
        status,
        output: status === "completed" ? "réponse" : null,
        error: status === "failed" ? "panne" : null,
        endedAt: "2026-08-25T10:00:02.000Z",
        lastEventAt: "2026-08-25T10:00:02.000Z",
        completionKind: status === "cancelled" ? "superseded_by_followup" : "terminal",
      };
      const current = {
        ...snapshot,
        updatedAt: "2026-08-25T11:00:00.000Z",
        runs: [terminalRun],
      };
      const next = applySendAcceptedToSnapshot(current, {
        runId: "run-new", workflowId: "wf-new", status: "queued",
        message: { ...message, id: `msg-${status}` },
        supersededRunId: terminalRun.id,
      });

      expect(next.runs[0]).toBe(terminalRun);
      expect(next.runs[0]?.status).toBe(status);
      expect(next.runs[0]?.completionKind).toBe(terminalRun.completionKind);
      expect(next.updatedAt).toBe("2026-08-25T11:00:00.000Z");
    }
  });

  test("un fold n'ajoute pas de run : seulement le message", () => {
    const withRun = applySendAcceptedToSnapshot(snapshot, {
      runId: "run-new", workflowId: "wf-new", status: "queued", run,
    });
    const folded = applySendAcceptedToSnapshot({ ...snapshot, runs: [run] }, {
      runId: "run-new",
      workflowId: "wf-new",
      status: "queued",
      foldedIntoRunId: "run-new",
      message: { ...message, runId: "run-new" },
    });
    expect(folded.runs).toHaveLength(1);
    expect(folded.messages[0]?.id).toBe("msg-1");
    expect(withRun.messages).toHaveLength(0);
  });

  test("marque le run remplacé comme cancelled", () => {
    const previous = {
      ...run, id: "run-old", status: "running" as const, startedAt: "2026-08-25T09:50:00.000Z",
    };
    const next = applySendAcceptedToSnapshot(
      { ...snapshot, runs: [previous] },
      { runId: "run-new", workflowId: "wf-new", status: "queued", message, run, supersededRunId: "run-old" },
    );
    expect(next.runs.find((item) => item.id === "run-old")?.status).toBe("cancelled");
    expect(next.runs.find((item) => item.id === "run-new")?.status).toBe("queued");
  });

  test("le roster remonte le fil, allume running, sans pastille non-lu sur le fil ouvert", () => {
    const next = applySendAcceptedToRoster(roster, {
      threadId: "thread-a",
      accepted: { runId: "run-new", workflowId: "wf-new", status: "queued", message },
      openThreadId: "thread-a",
    });
    expect(next.bots[0]!.id).toBe("bot-a");
    expect(next.bots[0]!.running).toBe(true);
    expect(next.bots[0]!.preview).toBe("sonde latence");
    expect(next.bots[0]!.unread).toBeFalsy();
    expect(next.bots[0]!.lastActivityAt).toBe("2026-08-25T10:00:00.000Z");
    expect(applySendAcceptedToRoster(next, {
      threadId: "thread-a",
      accepted: { runId: "run-new", workflowId: "wf-new", status: "queued", message },
      openThreadId: "thread-a",
    })).toBe(next);
  });

  test("un 202 en retard ne recule ni l'activité ni l'aperçu ni running", () => {
    const afterSse = applyProductEventToRoster(
      roster,
      completedWithText("thread-a", "réponse SSE", {
        cursor: 51,
        occurredAt: "2026-08-25T10:00:01.000Z",
      }),
      { openThreadId: "thread-b" },
    );
    const next = applySendAcceptedToRoster(afterSse, {
      threadId: "thread-a",
      accepted: { runId: "run-new", workflowId: "wf-new", status: "queued", message },
      openThreadId: "thread-b",
    });

    expect(next).toBe(afterSse);
    expect(next.bots[0]!.lastActivityAt).toBe("2026-08-25T10:00:01.000Z");
    expect(next.bots[0]!.preview).toBe("réponse SSE");
    expect(next.bots[0]!.running).toBe(false);
  });
});
