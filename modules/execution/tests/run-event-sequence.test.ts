import { describe, expect, test } from "bun:test";
import {
  RUN_EVENT_SEQUENCE_CONFLICT_CODE,
  RunEventSequenceConflictError,
  nextSequenceAfter,
  proposedSequenceConflict,
} from "../src/domain/run-event-sequence";

describe("séquences d'événements d'un run (S2c)", () => {
  test("la suivante vient après la dernière, 0 pour un run sans événement", () => {
    expect(nextSequenceAfter(null)).toBe(0);
    expect(nextSequenceAfter(undefined)).toBe(0);
    expect(nextSequenceAfter(4)).toBe(5);
    expect(nextSequenceAfter("41")).toBe(42);
    expect(() => nextSequenceAfter("x")).toThrow("invalid stored run event sequence");
    expect(() => nextSequenceAfter(-1)).toThrow("invalid stored run event sequence");
  });

  test("un lot numéroté tient après la dernière, strictement croissant, trous permis", () => {
    expect(proposedSequenceConflict(3, [3, 4, 5])).toBeNull();
    // Un tour de salon muet saute ses deltas : le lot garde des trous.
    expect(proposedSequenceConflict(3, [5, 9])).toBeNull();
    expect(proposedSequenceConflict(0, [])).toBeNull();
  });

  test("une séquence déjà prise, répétée ou en recul est une collision nommée", () => {
    expect(proposedSequenceConflict(3, [2, 3])).toEqual({ proposed: 2, next: 3 });
    expect(proposedSequenceConflict(3, [3, 3])).toEqual({ proposed: 3, next: 4 });
    expect(proposedSequenceConflict(3, [5, 4])).toEqual({ proposed: 4, next: 6 });
    expect(proposedSequenceConflict(0, [Number.NaN])).toEqual({ proposed: Number.NaN, next: 0 });
    const error = new RunEventSequenceConflictError("run-1", 2, 3);
    expect(error.code).toBe(RUN_EVENT_SEQUENCE_CONFLICT_CODE);
    expect(error.message).toContain("séquence 2 proposée, 3 attendue");
  });
});
