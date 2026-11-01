import { describe, expect, test } from "bun:test";
import { settledBotModelSaves, trackBotModelSave } from "../../../src/lib/bots/bot-model-saves";

function held() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function isSettled(promise: Promise<void>): Promise<boolean> {
  let settled = false;
  void promise.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return settled;
}

describe("bot model saves: a send waits for every picker of its bot", () => {
  test("nothing pending: the wait resolves at once", async () => {
    expect(await isSettled(settledBotModelSaves("bot-empty"))).toBe(true);
    expect(await isSettled(settledBotModelSaves(undefined))).toBe(true);
  });

  test("waits for every save of that bot, and only that bot", async () => {
    const page = held();
    const composer = held();
    const other = held();
    trackBotModelSave("bot-a", page.promise);
    trackBotModelSave("bot-a", composer.promise);
    trackBotModelSave("bot-b", other.promise);
    const wait = settledBotModelSaves("bot-a");
    page.release();
    expect(await isSettled(wait)).toBe(false);
    composer.release();
    expect(await isSettled(wait)).toBe(true);
    expect(await isSettled(settledBotModelSaves("bot-b"))).toBe(false);
    other.release();
    await other.promise;
  });

  test("a failed save does not block the send, and leaves the registry", async () => {
    const failed = Promise.reject(new Error("PATCH failed"));
    trackBotModelSave("bot-c", failed);
    await failed.catch(() => {});
    expect(await isSettled(settledBotModelSaves("bot-c"))).toBe(true);
  });
});
