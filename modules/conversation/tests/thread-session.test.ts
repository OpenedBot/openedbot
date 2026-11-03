import { describe, expect, test } from "bun:test";
import {
  latestCapabilityChange,
  threadSessionKey,
  threadSessionKeys,
  threadSessionStale,
} from "../src/domain/thread-session";

const at = (iso: string) => new Date(iso);

describe("session Hermes d'un fil par génération (0163)", () => {
  test("la génération 0 garde la clé d'origine, les suivantes la suffixent", () => {
    expect(threadSessionKey("ohb:o:t", 0)).toBe("ohb:o:t");
    expect(threadSessionKey("ohb:o:t", 3)).toBe("ohb:o:t:gen3");
    expect(threadSessionKeys("ohb:o:t", 2)).toEqual(["ohb:o:t", "ohb:o:t:gen1", "ohb:o:t:gen2"]);
    expect(threadSessionKeys("ohb:o:t", -1)).toEqual(["ohb:o:t"]);
    expect(threadSessionKeys("ohb:o:t", Number.NaN)).toEqual(["ohb:o:t"]);
  });

  test("périmée seulement quand une capacité a changé APRÈS l'ouverture de la session", () => {
    const state = { generation: 0, openedAt: at("2026-11-02T10:00:00Z"), threadCreatedAt: at("2026-11-01T00:00:00Z") };
    expect(threadSessionStale(state, null)).toBe(false);
    expect(threadSessionStale(state, at("2026-11-02T09:59:59Z"))).toBe(false);
    expect(threadSessionStale(state, at("2026-11-02T10:00:00Z"))).toBe(false);
    expect(threadSessionStale(state, at("2026-11-02T10:00:01Z"))).toBe(true);
  });

  test("un fil d'avant 0163 se mesure à sa création : une rotation de trop plutôt qu'un bot sur d'anciens outils", () => {
    const legacy = { generation: 0, openedAt: null, threadCreatedAt: at("2026-11-01T00:00:00Z") };
    expect(threadSessionStale(legacy, at("2026-11-02T00:00:00Z"))).toBe(true);
    expect(threadSessionStale(legacy, at("2026-10-31T00:00:00Z"))).toBe(false);
  });

  test("le changement qui compte est le plus récent, racine ou profil", () => {
    const root = at("2026-11-02T10:00:00Z");
    const profile = at("2026-11-02T11:00:00Z");
    expect(latestCapabilityChange(null, null)).toBeNull();
    expect(latestCapabilityChange(root, null)).toBe(root);
    expect(latestCapabilityChange(null, profile)).toBe(profile);
    expect(latestCapabilityChange(root, profile)).toBe(profile);
    expect(latestCapabilityChange(profile, root)).toBe(profile);
  });
});
