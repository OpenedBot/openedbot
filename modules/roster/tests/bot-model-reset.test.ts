import { describe, expect, test } from "bun:test";
import type { BotProfileModelSyncDto } from "@openedbot/contracts-api";
import { alignProfileModels } from "../src/application/bot-model-reset";

const runtime = { selectedProvider: "xai-oauth", selectedModel: "grok-4.7" };
const catalog = { providers: [{ slug: "xai-oauth", authenticated: true, models: [{ id: "grok-4.7" }] }] };

function freshSync(total: number): BotProfileModelSyncDto {
  return { id: "sync-1", status: "running", total, done: 0, aligned: 0, failed: 0, startedAt: "2026-10-23T00:00:00.000Z", finishedAt: null };
}

function scriptedClient(options: { catalogFails?: boolean; failingProfile?: string } = {}) {
  const writes: string[] = [];
  return {
    writes,
    modelOptions: async () => {
      if (options.catalogFails) throw new Error("unreachable");
      return catalog;
    },
    hostProfileInventory: async () => ({
      profiles: [
        { name: "already", model: { provider: "xai-oauth", default: "grok-4.7" } },
        { name: "stale", model: { provider: "openai-codex", default: "gpt-6" } },
        { name: "broken", model: { provider: "openai-codex", default: "gpt-6" } },
        { name: "edited", model: { provider: "openai-codex", default: "gpt-6" } },
      ],
    }),
    hostSetProfileModel: async (profile: string, selection: { provider: string; model: string }) => {
      writes.push(`${profile}:${selection.provider}/${selection.model}`);
      if (profile === options.failingProfile) throw new Error("host write failed");
      return { applied: true };
    },
    hostSetProfileModels: async (profiles: string[], selection: { provider: string; model: string }) => {
      writes.push(`batch:${profiles.join("+")}:${selection.provider}/${selection.model}`);
      return profiles.map((profile) => ({ profile, applied: profile !== options.failingProfile }));
    },
  };
}

describe("alignProfileModels", () => {
  test("writes only the profiles that differ, and counts every profile once", async () => {
    const client = scriptedClient({ failingProfile: "broken" });
    const sync = freshSync(4);
    await alignProfileModels(sync, [
      { botId: "b1", profile: "already" },
      { botId: "b2", profile: "stale" },
      { botId: "b3", profile: "broken" },
      { botId: "b4", profile: "edited" },
    ], {
      client: client as never,
      runtime,
      batch: false,
      // b4 got its own model after the reset: it no longer follows the global one.
      stillFollowing: async (ids) => new Set(ids.filter((id) => id !== "b4")),
    });
    expect(client.writes.sort()).toEqual(["broken:xai-oauth/grok-4.7", "stale:xai-oauth/grok-4.7"]);
    expect(sync).toMatchObject({ status: "done", total: 4, done: 4, aligned: 2, failed: 1 });
    expect(sync.finishedAt).not.toBeNull();
  });

  test("an unreadable catalogue ends the sync with every profile failed, never stuck running", async () => {
    const client = scriptedClient({ catalogFails: true });
    const sync = freshSync(2);
    await alignProfileModels(sync, [{ botId: "b1", profile: "stale" }, { botId: "b2", profile: "broken" }], {
      client: client as never,
      runtime,
      batch: false,
      stillFollowing: async (ids) => new Set(ids),
    });
    expect(client.writes).toEqual([]);
    expect(sync).toMatchObject({ status: "done", done: 2, aligned: 0, failed: 2 });
  });

  test("with profile_model_batch, the profiles to write go in one host call", async () => {
    const client = scriptedClient({ failingProfile: "broken" });
    const sync = freshSync(4);
    await alignProfileModels(sync, [
      { botId: "b1", profile: "already" },
      { botId: "b2", profile: "stale" },
      { botId: "b3", profile: "broken" },
      { botId: "b4", profile: "edited" },
    ], {
      client: client as never,
      runtime,
      batch: true,
      stillFollowing: async (ids) => new Set(ids.filter((id) => id !== "b4")),
    });
    expect(client.writes).toEqual(["batch:stale+broken:xai-oauth/grok-4.7"]);
    expect(sync).toMatchObject({ status: "done", done: 4, aligned: 2, failed: 1 });
  });
});
