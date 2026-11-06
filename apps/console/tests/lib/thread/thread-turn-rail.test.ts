import { describe, expect, test } from "bun:test";
import type { ThreadMessageDto } from "@openedbot/contracts-api";
import { buildThreadRailTurns, litRailTurns, throttledFrame, type FrameIo } from "../../../src/lib/thread/thread-turn-rail";

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  authorBot?: ThreadMessageDto["authorBot"],
): ThreadMessageDto {
  return {
    id,
    role,
    content: [{ type: "text", text }],
    runId: null,
    createdAt: "2026-10-08T00:00:00.000Z",
    authorBot: authorBot ?? null,
  };
}

const bot = { id: "bot-1", name: "Recette", slug: "recette", face: null };

describe("buildThreadRailTurns", () => {
  test("un trait par message opérateur, la réponse est le premier assistant", () => {
    expect(buildThreadRailTurns([
      message("u1", "user", "Question une"),
      message("a1", "assistant", "Réponse une"),
      message("u2", "user", "Question deux"),
      message("a2", "assistant", "Réponse deux"),
    ])).toEqual([
      { targetId: "message:u1", question: "Question une", answer: "Réponse une" },
      { targetId: "message:u2", question: "Question deux", answer: "Réponse deux" },
    ]);
  });

  test("un user écrit par un autre bot ne prend pas de trait et ne vole pas la réponse", () => {
    expect(buildThreadRailTurns([
      message("u1", "user", "Brief"),
      message("in", "user", "Je prends le panier", bot),
      message("a1", "assistant", "Synthèse"),
      message("a2", "assistant", "Deuxième contribution"),
    ])).toEqual([
      { targetId: "message:u1", question: "Brief", answer: "Synthèse" },
    ]);
  });
});

describe("throttledFrame", () => {
  function fakeIo() {
    let now = 0;
    let nextId = 1;
    const frames = new Map<number, () => void>();
    const timers = new Map<number, { at: number; run: () => void }>();
    const io: FrameIo = {
      now: () => now,
      requestFrame: (callback) => { const id = nextId++; frames.set(id, callback); return id; },
      cancelFrame: (id) => { frames.delete(id); },
      setTimer: (callback, ms) => { const id = nextId++; timers.set(id, { at: now + ms, run: callback }); return id as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: (id) => { timers.delete(id as unknown as number); },
    };
    const frame = () => { const pending = [...frames.values()]; frames.clear(); for (const run of pending) run(); };
    const advance = (ms: number) => {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.run(); }
    };
    return { io, frame, advance };
  }

  test("measures at most once per interval, and never drops the last request", () => {
    const { io, frame, advance } = fakeIo();
    let runs = 0;
    const throttled = throttledFrame(() => { runs += 1; }, 100, io);
    throttled.schedule();
    frame();
    expect(runs).toBe(1);
    // A pinned thread scrolls on every frame while an answer streams.
    for (let index = 0; index < 10; index += 1) {
      advance(8);
      throttled.schedule();
      frame();
    }
    expect(runs).toBe(1);
    advance(20);
    frame();
    expect(runs).toBe(2);
  });

  test("cancel drops a pending measure", () => {
    const { io, frame, advance } = fakeIo();
    let runs = 0;
    const throttled = throttledFrame(() => { runs += 1; }, 100, io);
    throttled.schedule();
    throttled.cancel();
    frame();
    throttled.schedule();
    frame();
    throttled.schedule();
    throttled.cancel();
    advance(200);
    frame();
    expect(runs).toBe(1);
  });
});

describe("litRailTurns", () => {
  const view = { top: 0, bottom: 500 };

  test("a turn is lit while its section, up to the next turn, crosses the view", () => {
    expect([...litRailTurns([-300, 100, 400, 900], view)]).toEqual([0, 1, 2]);
    expect([...litRailTurns([-900, -300, 600], view)]).toEqual([1]);
  });

  test("turns out of the mounted rows sit above them, or below them, never across the view", () => {
    // Turns 0-1 are above the mounted rows, 4-5 below: the view shows 2 and 3.
    expect([...litRailTurns([null, null, -200, 300, null, null], view)]).toEqual([2, 3]);
    // The last mounted turn runs to the end of the view: the turns after it stay dark.
    expect([...litRailTurns([null, -100, 200, null], view)]).toEqual([1, 2]);
  });
});
