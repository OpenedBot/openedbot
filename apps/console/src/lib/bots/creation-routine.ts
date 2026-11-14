import type { CreateRoutineInput, RoutineDto } from "@openedbot/contracts-api";

type RoutineClient = {
  routines: (botId: string) => Promise<{ routines: RoutineDto[] }>;
  createRoutine: (botId: string, input: CreateRoutineInput) => Promise<RoutineDto>;
};

/**
 * Programs the routine a creation brought (a home suggestion) on the bot
 * that now exists. Idempotent by name: a bot that already carries a routine
 * of that name (a replayed creation answered with the first bot, a second
 * tab) gets no twin, and the existing routine is returned untouched.
 *
 * It runs AFTER the creation and on its own: the bot is never held back by
 * its routine. A refusal (quota, schedule) is the caller's to report.
 */
export async function ensureCreationRoutine(
  client: RoutineClient,
  botId: string,
  routine: CreateRoutineInput,
): Promise<{ routine: RoutineDto; created: boolean }> {
  const { routines } = await client.routines(botId);
  const existing = routines.find((entry) => entry.name === routine.name);
  if (existing) return { routine: existing, created: false };
  return { routine: await client.createRoutine(botId, routine), created: true };
}
