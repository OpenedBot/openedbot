import { describe, expect, test } from "bun:test";
import { cursorForOpenThread, streamStartCursor } from "../../../src/lib/stream/thread-stream-cursor";

describe("cursorForOpenThread", () => {
  test("un nouveau fil repart de SON snapshot, jamais du curseur de l'ancien", () => {
    expect(cursorForOpenThread({
      openThreadId: "thread-a", nextThreadId: "thread-b", currentCursor: 900, snapshotCursor: 120,
    })).toBe(120);
  });

  test("sans snapshot, le fil attend à zéro : l'abonnement ne part pas de là", () => {
    expect(cursorForOpenThread({
      openThreadId: undefined, nextThreadId: "thread-a", currentCursor: 0, snapshotCursor: undefined,
    })).toBe(0);
  });

  test("le même fil garde le plus avancé du flux et du snapshot", () => {
    expect(cursorForOpenThread({
      openThreadId: "thread-a", nextThreadId: "thread-a", currentCursor: 900, snapshotCursor: 120,
    })).toBe(900);
    expect(cursorForOpenThread({
      openThreadId: "thread-a", nextThreadId: "thread-a", currentCursor: 10, snapshotCursor: 120,
    })).toBe(120);
  });

  test("aucun fil ouvert : zéro", () => {
    expect(cursorForOpenThread({
      openThreadId: "thread-a", nextThreadId: undefined, currentCursor: 900, snapshotCursor: 120,
    })).toBe(0);
  });
});

describe("streamStartCursor", () => {
  test("le curseur d'organisation prime : rien à rejouer au démarrage", () => {
    expect(streamStartCursor({ cursor: 120, organizationCursor: 9_800 })).toBe(9_800);
  });

  test("API antérieure sans curseur d'organisation : repli sur celui du fil", () => {
    expect(streamStartCursor({ cursor: 120 })).toBe(120);
    expect(streamStartCursor(undefined)).toBeUndefined();
  });

  test("une page partielle reprend à la borne sûre même si elle contient un événement plus récent", () => {
    // Event 119 can belong to a run omitted from the page containing event 120.
    expect(streamStartCursor({ cursor: 120, organizationCursor: 5 })).toBe(5);
  });
});
