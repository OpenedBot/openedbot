import { describe, expect, test } from "bun:test";
import { provisionJustFinished, threadStartShown } from "../../src/components/thread-start-stage";

const base = { provisioning: false, runs: [] };

describe("threadStartShown", () => {
  test("un bot neuf dont le profil se prépare démarre au centre, accueil compris (il attend le profil)", () => {
    expect(threadStartShown({ ...base, provisioning: true })).toBe(true);
    expect(threadStartShown({ ...base, provisioning: true, runs: [{ status: "queued" }] })).toBe(true);
  });

  test("profil prêt, le fil et le composer arrivent : l'accueil s'y écrit en direct", () => {
    expect(threadStartShown({ ...base, runs: [{ status: "queued" }] })).toBe(false);
    expect(threadStartShown({ ...base, runs: [{ status: "running" }] })).toBe(false);
  });

  test("un accueil en échec n'est pas caché derrière l'attente", () => {
    expect(threadStartShown({ ...base, provisioning: true, runs: [{ status: "failed" }] })).toBe(false);
  });

  test("un fil vide au repos garde son état vide habituel", () => {
    expect(threadStartShown(base)).toBe(false);
  });
});

describe("provisionJustFinished", () => {
  test("le composer n'arrive (avec son toast) que pour un bot vu en préparation puis prêt", () => {
    expect(provisionJustFinished({ botId: "a", status: "preparing" }, { botId: "a", status: null })).toBe(true);
  });

  test("ni au montage, ni sur un échec, ni en changeant de bot", () => {
    expect(provisionJustFinished(null, { botId: "a", status: null })).toBe(false);
    expect(provisionJustFinished({ botId: "a", status: "preparing" }, { botId: "a", status: "failed" })).toBe(false);
    expect(provisionJustFinished({ botId: "a", status: "preparing" }, { botId: "b", status: null })).toBe(false);
    expect(provisionJustFinished({ botId: "a", status: "preparing" }, { botId: "a", status: "preparing" })).toBe(false);
  });
});
