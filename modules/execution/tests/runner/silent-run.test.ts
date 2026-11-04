import { describe, expect, test } from "bun:test";
import type { HermesRunDetails } from "@openedbot/hermes";
import { silentRunStillWorking, watchdogStopCause } from "../../src/application/runner/silent-run";

function client(result: HermesRunDetails["status"] | Error) {
  return {
    getRunStatus: async (): Promise<HermesRunDetails> => {
      if (result instanceof Error) throw result;
      return { id: "hermes-1", status: result, output: null, usage: null, pendingSteer: null } as HermesRunDetails;
    },
  };
}

const signal = new AbortController().signal;

describe("silentRunStillWorking", () => {
  test("un run muet que Hermes dit actif n'est pas arrêté", async () => {
    expect(await silentRunStillWorking(client("running"), "hermes-1", signal, "run-1", Date.now() - 130_000)).toBe(true);
  });

  test("un run terminé, injoignable ou sans identifiant est arrêté", async () => {
    expect(await silentRunStillWorking(client("completed"), "hermes-1", signal, "run-1", Date.now())).toBe(false);
    expect(await silentRunStillWorking(client(new Error("unreachable")), "hermes-1", signal, "run-1", Date.now())).toBe(false);
    expect(await silentRunStillWorking(client("running"), null, signal, "run-1", Date.now())).toBe(false);
  });
});

describe("watchdogStopCause", () => {
  test("nomme l'arrêt au lieu de « Run Hermes annulé »", () => {
    expect(watchdogStopCause(true, 120_000)).toEqual({
      errorCode: "RUN_INACTIVITY_TIMEOUT",
      message: "Le run ne donnait plus signe de vie depuis 120 s : openedbot l’a arrêté.",
    });
    expect(watchdogStopCause(false, 120_000).errorCode).toBe("RUN_TIMEOUT");
  });
});
