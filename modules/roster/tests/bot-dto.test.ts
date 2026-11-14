import { describe, expect, test } from "bun:test";
import { normalizeAutonomyPolicy } from "../src/domain/autonomous-workflow";
import { publicBot, type BotRow } from "../src/domain/bot-dto";

describe("publicBot autonomy contract", () => {
  const row = {
    id: "bot-1",
    threadId: "thread-1",
    name: "Scout",
    slug: "scout",
    description: null,
    instructions: "",
    model: null,
    reasoningEffort: null,
    sectionId: "section-1",
    position: 0,
    pinned: false,
    face: null,
    voiceId: "elevenlabs:scout",
    label: null,
    replyLanguage: "auto",
    notifyOnFinish: true,
    speechRate: "1.00",
    permissionMode: "manual",
    hermesProfile: "scout",
    archivedAt: null,
    deletedAt: null,
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    awaitingApproval: false,
    preview: null,
    lastActivityAt: "2026-08-25T00:00:00.000Z",
    lastRunAt: null,
    autonomyEnabled: true,
    autonomyMaxDepth: 3,
    autonomyMaxSteps: 8,
    autonomyMaxHandoffs: 4,
    autonomyTimeoutSeconds: 1_800,
    autonomyTokenBudget: 120_000,
  } satisfies BotRow;

  // PostgreSQL rend `bigint` en chaîne décimale. Sans conversion, le client
  // juge le budget non entier et le remplace par le défaut : la valeur choisie
  // par l'opérateur disparaît au rechargement puis à l'enregistrement suivant.
  test("serialises the bigint token budget as a number", () => {
    const fromDriver = publicBot({ ...row, autonomyTokenBudget: "120000" });
    expect(fromDriver.autonomy.tokenBudget).toBe(120_000);
    expect(typeof fromDriver.autonomy.tokenBudget).toBe("number");
    expect(normalizeAutonomyPolicy(fromDriver.autonomy).tokenBudget).toBe(120_000);
  });

  test("keeps a numeric budget untouched", () => {
    expect(publicBot(row).autonomy.tokenBudget).toBe(120_000);
  });

  test("publie l'identifiant de voix sans le traiter comme un secret", () => {
    expect(publicBot(row).voiceId).toBe("elevenlabs:scout");
  });

  test("PERM2-2: publishes whether the host policy is in force, never the raw proof", () => {
    const managed = { ...row, hermesProfileManaged: true };
    expect(publicBot(row).hostPolicy).toBeNull();
    expect(publicBot({ ...managed, approvalPolicyMode: "ask_writes", approvalPolicyEffectiveAt: "2026-10-24T00:00:00Z" }).hostPolicy).toBe("effective");
    expect(publicBot({ ...managed, approvalPolicyMode: "ask_writes", approvalPolicyEffectiveAt: null }).hostPolicy).toBe("pending");
    expect(publicBot({ ...managed, approvalPolicyMode: null, approvalPolicyEffectiveAt: null }).hostPolicy).toBe("unproven");
    const published = publicBot({ ...managed, approvalPolicyMode: "ask_writes", approvalPolicyEffectiveAt: null }) as Record<string, unknown>;
    expect("approvalPolicyMode" in published || "approvalPolicyEffectiveAt" in published).toBe(false);
  });
});
