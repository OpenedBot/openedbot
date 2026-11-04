import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { readCloudSession } from "../../../src/lib/session/cloud-session";
import { signOut, SignOutNotConfirmedError } from "../../../src/lib/session/sign-out";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function signedInClient() {
  window.localStorage.setItem("ohb:cloud-session", JSON.stringify({ organizationId: "org-1", csrfToken: "csrf-1", userId: "user-1" }));
  const client = new QueryClient();
  client.setQueryData(["organization", "org-1", "roster"], { bots: [] });
  return client;
}

describe("signOut", () => {
  test("une révocation refusée (503) n'efface rien et le dit à l'appelant", async () => {
    const client = signedInClient();
    globalThis.fetch = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;

    await expect(signOut(client)).rejects.toBeInstanceOf(SignOutNotConfirmedError);
    expect(readCloudSession()?.userId).toBe("user-1");
    expect(client.getQueryData<unknown>(["organization", "org-1", "roster"])).toEqual({ bots: [] });
  });

  test("une API injoignable ne passe pas non plus pour une déconnexion", async () => {
    const client = signedInClient();
    globalThis.fetch = (async () => { throw new TypeError("network"); }) as unknown as typeof fetch;

    await expect(signOut(client)).rejects.toBeInstanceOf(SignOutNotConfirmedError);
    expect(readCloudSession()).not.toBeNull();
  });

  test("une révocation confirmée vide la fenêtre", async () => {
    const client = signedInClient();
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;

    await signOut(client);
    expect(readCloudSession()).toBeNull();
    expect(client.getQueryData<unknown>(["organization", "org-1", "roster"])).toBeUndefined();
  });

  test("un 401 de session : le serveur ne la connaît déjà plus, le nettoyage local suffit", async () => {
    const client = signedInClient();
    globalThis.fetch = (async () => Response.json(
      { error: { code: "SESSION_EXPIRED", message: "Session expirée." } },
      { status: 401 },
    )) as unknown as typeof fetch;

    await signOut(client);
    expect(readCloudSession()).toBeNull();
  });
});
