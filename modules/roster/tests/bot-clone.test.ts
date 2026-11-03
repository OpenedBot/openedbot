import { describe, expect, test } from "bun:test";
import type { BotDto } from "@openedbot/contracts-api";
import { BotCloneDraftError, botCreationDraftFromClone } from "../src/domain/bot-clone";
import { PERSONA_MAX_CHARS } from "../src/domain/persona";

const source: BotDto = {
  id: "bot-1",
  threadId: "thread-1",
  name: "Atlas",
  slug: "atlas",
  description: "Recherche",
  instructions: "# Atlas\n\nCite tes sources.",
  model: "claude-sonnet-4",
  reasoningEffort: "high",
  sectionId: "section-1",
  position: 3,
  pinned: true,
  face: { palette: "bleu", shape: "galet", eyes: "curieux", artwork: "ember" },
  voiceId: "voice-1",
  label: "Veille",
  replyLanguage: "fr",
  notifyOnFinish: false,
  speechRate: 1.25,
  permissionMode: "bypass",
  hermesProfile: "atlas",
  hermesProfileManaged: true,
  isolation: "profile",
  hasOwnRuntime: false,
  runtimeName: "Hermes",
  awaitingApproval: true,
  preview: "Dernier message",
  lastActivityAt: "2026-10-01T00:00:00.000Z",
  archivedAt: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  lastRunAt: "2026-10-01T00:00:00.000Z",
};

describe("botCreationDraftFromClone", () => {
  test("carries the persona, the face and the presentation settings", () => {
    const draft = botCreationDraftFromClone(source, { copyLabel: "copie" });
    expect(draft).toEqual({
      name: "Atlas (copie)",
      instructions: "# Atlas\n\nCite tes sources.",
      description: "Recherche",
      model: "claude-sonnet-4",
      reasoningEffort: "high",
      face: { palette: "bleu", shape: "galet", eyes: "curieux", artwork: "ember" },
      label: "Veille",
      replyLanguage: "fr",
      notifyOnFinish: false,
      speechRate: 1.25,
      voiceId: "voice-1",
    });
  });

  test("never copies the permission mode, the profile, identity or activity", () => {
    const draft = botCreationDraftFromClone(source) as Record<string, unknown>;
    for (const key of ["permissionMode", "hermesProfile", "id", "threadId", "slug", "sectionId", "pinned", "preview", "awaitingApproval"]) {
      expect(Object.hasOwn(draft, key)).toBe(false);
    }
  });

  test("drops a label the server would refuse instead of failing the copy", () => {
    expect(botCreationDraftFromClone({ ...source, label: "x".repeat(61) }).label).toBeUndefined();
  });

  test("refuses a persona over the server bound, never truncates it", () => {
    expect(() => botCreationDraftFromClone({ ...source, instructions: "p".repeat(PERSONA_MAX_CHARS + 1) }))
      .toThrow(BotCloneDraftError);
  });

  test("a new explicit profile must differ from the source profile", () => {
    expect(() => botCreationDraftFromClone(source, { hermesProfile: "atlas" })).toThrow(BotCloneDraftError);
    expect(botCreationDraftFromClone(source, { hermesProfile: "atlas-2" }).hermesProfile).toBe("atlas-2");
  });
});
