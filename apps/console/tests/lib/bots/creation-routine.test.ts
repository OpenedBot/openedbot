import { describe, expect, mock, test } from "bun:test";
import type { CreateRoutineInput, RoutineDto } from "@openedbot/contracts-api";
import { ensureCreationRoutine } from "../../../src/lib/bots/creation-routine";

const input: CreateRoutineInput = { name: "Point du vendredi", schedule: "0 17 * * 5", timezone: "Europe/Paris", message: "Le point.", enabled: true };
const dto = (name: string): RoutineDto => ({
  id: `routine-${name}`, botId: "bot-1", groupId: null, name, schedule: "0 17 * * 5", timezone: "Europe/Paris", message: "", enabled: true,
  nextRunAt: null, lastRunAt: null, missedCount: 0, lastMissedAt: null, createdAt: "", updatedAt: "",
} as RoutineDto);

describe("routine programmed with a created bot", () => {
  test("created when the bot has none of that name", async () => {
    const createRoutine = mock(async (_botId: string, body: CreateRoutineInput) => dto(body.name));
    const result = await ensureCreationRoutine({ routines: async () => ({ routines: [dto("Autre")] }), createRoutine }, "bot-1", input);
    expect(result.created).toBe(true);
    expect(createRoutine).toHaveBeenCalledWith("bot-1", input);
  });

  test("a replay finds the routine already there and creates no twin", async () => {
    const createRoutine = mock(async (_botId: string, body: CreateRoutineInput) => dto(body.name));
    const result = await ensureCreationRoutine({ routines: async () => ({ routines: [dto("Point du vendredi")] }), createRoutine }, "bot-1", input);
    expect(result).toEqual({ routine: dto("Point du vendredi"), created: false });
    expect(createRoutine).not.toHaveBeenCalled();
  });

  test("a refusal reaches the caller, it is not swallowed", async () => {
    const refused = new Error("Un bot ne porte pas plus de 10 routines.");
    await expect(ensureCreationRoutine({
      routines: async () => ({ routines: [] }),
      createRoutine: async () => { throw refused; },
    }, "bot-1", input)).rejects.toBe(refused);
  });
});
