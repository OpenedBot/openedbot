import { describe, expect, test } from "bun:test";
import type { AuthStatus } from "../../../src/lib/session/auth-status";
import { resolveAppFrameEntry, rootRewriteInput, rootRewriteOutput } from "../../../src/lib/session/public-landing-gate";

const at = (path: string) => new URL(path, "http://localhost:1420");

describe("rootRewriteInput", () => {
  test("la barre d'adresse sur / : l'aperçu, dans un onglet comme dans la coque native (plus de page publique)", () => {
    expect(rootRewriteInput(at("/"), "/")?.pathname).toBe("/");
    expect(rootRewriteInput(at("/landing"), "/landing")).toBeNull();
  });

  test("/home ouvre l'aperçu", () => {
    expect(rootRewriteInput(at("/home"), "/home")?.pathname).toBe("/");
  });

  test("un / rejoué depuis une entrée masquée (réglages sur le salon) reste l'aperçu interne", () => {
    expect(rootRewriteInput(at("/"), "/o/dev/settings")).toBeNull();
    expect(rootRewriteInput(at("/"), "/home")).toBeNull();
  });

  test("les autres chemins passent à la réécriture des espaces de travail", () => {
    expect(rootRewriteInput(at("/o/dev/settings"), "/o/dev/settings")).toBeNull();
  });
});

describe("rootRewriteOutput", () => {
  test("l'aperçu sans organisation s'affiche /home ; plus de chemin interne de page publique", () => {
    expect(rootRewriteOutput("/", null)).toBe("/home");
    expect(rootRewriteOutput("/", "org-1")).toBeNull();
    expect(rootRewriteOutput("/landing", null)).toBeNull();
  });
});

const session: AuthStatus = { kind: "session", ssoEnabled: true, user: null, sessionId: "s1", reason: null, mustChangePassword: false };
const none: AuthStatus = { kind: "none", ssoEnabled: true, user: null, sessionId: null, reason: "SESSION_EXPIRED", mustChangePassword: false };
const unknown: AuthStatus = { kind: "unknown", ssoEnabled: false, user: null, sessionId: null, reason: null, mustChangePassword: false };

describe("resolveAppFrameEntry", () => {
  test("une session entre dans l'application", () => {
    expect(resolveAppFrameEntry(session)).toEqual({ kind: "app" });
  });

  test("sans session, la coque renvoie vers /login avec la raison, sur tous les hôtes", () => {
    expect(resolveAppFrameEntry(none)).toEqual({ kind: "login", reason: "SESSION_EXPIRED" });
    expect(resolveAppFrameEntry(unknown)).toEqual({ kind: "login", reason: null });
  });
});
