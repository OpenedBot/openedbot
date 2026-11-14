import { describe, expect, test } from "bun:test";
import { capturePersistedReadScope, clearPersistedQueries } from "../../src/lib/query-persister";

function signIn(userId: string) {
  window.localStorage.setItem("openedbot:cloud-session", JSON.stringify({ organizationId: "org-1", csrfToken: `csrf-${userId}`, userId }));
}

describe("capturePersistedReadScope", () => {
  test("une lecture sans purge ni changement de compte reste valable", () => {
    signIn("user-a");
    expect(capturePersistedReadScope().stillCurrent()).toBe(true);
  });

  test("une purge pendant la lecture l'invalide, même si le même compte revient", async () => {
    signIn("user-a");
    const scope = capturePersistedReadScope();
    await clearPersistedQueries();
    signIn("user-a");
    expect(scope.stillCurrent()).toBe(false);
  });

  test("un autre compte connecté pendant la lecture l'invalide", () => {
    signIn("user-a");
    const scope = capturePersistedReadScope();
    signIn("user-b");
    expect(scope.stillCurrent()).toBe(false);
  });
});
