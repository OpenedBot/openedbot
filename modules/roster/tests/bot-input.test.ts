import { describe, expect, test } from "bun:test";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { AUTONOMY_CEILINGS, AUTONOMY_DEFAULTS } from "../src/domain/autonomous-workflow";
import { creationRequestKey, readAutonomy, readCreateBotInput, readVoiceId, slugify } from "../src/domain/bot-input";

describe("readAutonomy", () => {
  test("applies defaults on creation while preserving explicit partial values", () => {
    expect(readAutonomy(undefined, true)).toEqual(AUTONOMY_DEFAULTS);
    expect(readAutonomy({ enabled: false, maxSteps: 2 }, true)).toEqual({
      ...AUTONOMY_DEFAULTS,
      enabled: false,
      maxSteps: 2,
    });
  });

  test("returns only supplied fields on patch so omitted values stay unchanged", () => {
    expect(readAutonomy({ timeoutSeconds: 60 }, false)).toEqual({ timeoutSeconds: 60 });
    expect(readAutonomy({}, false)).toEqual({});
  });

  test("accepts every inclusive minimum and server ceiling", () => {
    expect(readAutonomy({
      maxDepth: 1,
      maxSteps: 1,
      maxHandoffs: 0,
      timeoutSeconds: 60,
      tokenBudget: 1_000,
    }, false)).toEqual({
      maxDepth: 1,
      maxSteps: 1,
      maxHandoffs: 0,
      timeoutSeconds: 60,
      tokenBudget: 1_000,
    });
    expect(readAutonomy({ ...AUTONOMY_CEILINGS }, false)).toEqual(AUTONOMY_CEILINGS);
  });

  test("rejects values outside bounds, non-integers and malformed partial policies", () => {
    const invalid = [
      { maxDepth: 0 },
      { maxDepth: AUTONOMY_CEILINGS.maxDepth + 1 },
      { maxSteps: 0 },
      { maxHandoffs: -1 },
      { timeoutSeconds: 59 },
      { tokenBudget: 999 },
      { maxSteps: 1.5 },
      { tokenBudget: Number.POSITIVE_INFINITY },
      { enabled: "yes" },
    ];
    for (const value of invalid) {
      expect(() => readAutonomy(value, false)).toThrow(HttpError);
      try {
        readAutonomy(value, false);
      } catch (error) {
        expect(error).toMatchObject({ status: 400, code: "AUTONOMY_POLICY_INVALID" });
      }
    }
    for (const value of [null, [], "autonomous"]) {
      expect(() => readAutonomy(value, false)).toThrow(HttpError);
    }
  });
});

describe("readVoiceId", () => {
  test("partage la normalisation création/patch et permet d'effacer la voix", () => {
    expect(readVoiceId("  elevenlabs:scout  ")).toBe("elevenlabs:scout");
    expect(readVoiceId("")).toBeNull();
    expect(readVoiceId(null)).toBeNull();
  });

  test("refuse une forme JSON invalide ou un identifiant supérieur à 512 caractères", () => {
    for (const value of [42, {}, "v".repeat(513)]) {
      expect(() => readVoiceId(value)).toThrow(
        expect.objectContaining({ status: 400, code: "BOT_VOICE_ID_INVALID" }),
      );
    }
  });
});

describe("slugify", () => {
  test("never yields a profile name Hermes reserves", () => {
    expect(slugify("Test")).toBe("test-bot");
    expect(slugify("Root")).toBe("root-bot");
    expect(slugify("Testeur")).toBe("testeur");
    // openedbot's own check profiles (PERM2-7a) are never a bot's profile.
    expect(slugify("openedbot reviewer")).toBe("openedbot-reviewer-bot");
    expect(slugify("openedbot model check")).toBe("openedbot-model-check-bot");
  });
});

describe("create bot input greeting", () => {
  test("recognizes only an explicit true value", () => {
    const base = { name: "Atlas" };
    expect(readCreateBotInput({ ...base, greet: true }).greet).toBe(true);
    expect(readCreateBotInput({ ...base, greet: false }).greet).toBe(false);
    expect(readCreateBotInput(base).greet).toBe(false);
  });
});

describe("create bot input editor settings and request id (0135)", () => {
  test("reads the editor settings with the same rules as the PATCH", () => {
    const input = readCreateBotInput({
      name: "Atlas",
      label: "  Recherche  ",
      permissionMode: "auto",
      notifyOnFinish: false,
      replyLanguage: "fr",
      speechRate: 1.25,
    });
    expect(input.editor).toEqual({
      label: "Recherche",
      permissionMode: "auto",
      notifyOnFinish: false,
      replyLanguage: "fr",
      speechRate: 1.25,
    });
  });

  test("absent settings stay absent so the column defaults apply", () => {
    expect(readCreateBotInput({ name: "Atlas" }).editor).toEqual({});
    expect(readCreateBotInput({ name: "Atlas" }).clientRequestId).toBeNull();
  });

  test("refuses an invalid setting instead of creating a half-configured bot", () => {
    for (const [body, code] of [
      [{ name: "Atlas", permissionMode: "yolo" }, "BOT_PERMISSION_MODE_INVALID"],
      [{ name: "Atlas", label: "x".repeat(61) }, "BOT_LABEL_TOO_LONG"],
      [{ name: "Atlas", notifyOnFinish: "yes" }, "BOT_NOTIFY_INVALID"],
    ] as const) {
      expect(() => readCreateBotInput(body)).toThrow(HttpError);
      try {
        readCreateBotInput(body);
      } catch (error) {
        expect(error).toMatchObject({ code });
      }
    }
  });

  test("accepts a UUID request id, lowercased, and refuses anything else", () => {
    expect(readCreateBotInput({ name: "Atlas", clientRequestId: "3C3C3C3C-0000-4000-8000-000000000001" }).clientRequestId)
      .toBe("3c3c3c3c-0000-4000-8000-000000000001");
    for (const clientRequestId of ["", "1234", 42, {}]) {
      expect(() => readCreateBotInput({ name: "Atlas", clientRequestId })).toThrow(HttpError);
    }
  });
});

describe("creationRequestKey (0136)", () => {
  const id = "3c3c3c3c-0000-4000-8000-000000000001";

  test("ignores key order and the request id itself", () => {
    expect(creationRequestKey("bots", { name: "Atlas", face: { eyes: "curieux", palette: "bleu" }, clientRequestId: id }))
      .toBe(creationRequestKey("bots", { face: { palette: "bleu", eyes: "curieux" }, name: "Atlas" }));
  });

  test("tells apart another body and another route", () => {
    const key = creationRequestKey("bots", { name: "Atlas" });
    expect(creationRequestKey("bots", { name: "Atlas bis" })).not.toBe(key);
    expect(creationRequestKey("template:00000000-0000-4000-8000-000000000001", { name: "Atlas" })).not.toBe(key);
  });

  test("readCreateBotInput binds the key only when an id is sent", () => {
    expect(readCreateBotInput({ name: "Atlas" }).clientRequestKey).toBeNull();
    expect(readCreateBotInput({ name: "Atlas", clientRequestId: id }).clientRequestKey)
      .toBe(creationRequestKey("bots", { name: "Atlas" }));
  });
});
