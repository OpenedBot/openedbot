import { describe, expect, test } from "bun:test";
import { classifyHermesSchedule, mapHermesFace, scheduleLimitation } from "../src/domain/runtime-profile-import";

describe("classifyHermesSchedule", () => {
  test("garde un cron 5 champs et classe every / Nh / le reste", () => {
    expect(classifyHermesSchedule("30 8 * * 1,2,3,4,5")).toEqual({
      kind: "cron",
      cron: "30 8 * * 1,2,3,4,5",
    });
    expect(classifyHermesSchedule("every 30m").kind).toBe("every");
    expect(classifyHermesSchedule("2h").kind).toBe("ambiguous");
    expect(classifyHermesSchedule("monday at 9").kind).toBe("other");
    expect(scheduleLimitation("every", "scout", "every 30m")).toBe("routine-schedule-every:scout:every 30m");
  });
  test("anchors only exact positive intervals and preserves explicit one-shots", () => {
    for (const [schedule, cron] of [
      ["every 30m", "*/30 * * * *"], ["every 60 minutes", "0 * * * *"],
      ["every 2 hours", "0 */2 * * *"], ["every 24h", "0 0 * * *"], ["every 1d", "0 0 * * *"],
    ]) expect(classifyHermesSchedule(schedule!)).toEqual({ kind: "every", cron: cron! });
    for (const schedule of ["every 0m", "every 7m", "every 25h", "every 2d"]) {
      expect(classifyHermesSchedule(schedule)).toEqual({ kind: "every", cron: null });
    }
    for (const schedule of ["once", "once in 2h", "in 30m"]) expect(classifyHermesSchedule(schedule).kind).toBe("once");
  });
});

describe("mapHermesFace", () => {
  test("mappe shape/color amont vers bloub, et un hex vers la couleur la plus proche", () => {
    const face = mapHermesFace({ shape: "circle", color: "blue", seed: "scout" });
    expect(face.shape).toBe("cercle");
    expect(face.palette).toBe("bleu");
    const hex = mapHermesFace({ shape: "unknown", color: "#3b93f0", seed: "scout" });
    expect(hex.palette).toBe("bleu");
    expect(hex.shape).not.toBe("");
    const withArt = mapHermesFace({ seed: "scout", artwork: "/api/attachments/x" });
    expect(withArt.artwork).toBe("/api/attachments/x");
  });
});
