import { describe, expect, test } from "bun:test";
import { HermesClient, HermesClientError } from "../../src/index";
import type { HermesRequestKind, HermesTransport } from "../../src/transport/types";

/**
 * `HermesClient.deleteSession` face à un transport factice.
 *
 * C'est la seule écriture destructive qu'openedbot adresse au gateway du client :
 * elle mérite un chemin exact, une méthode exacte, et un contrat d'erreur qui
 * distingue « déjà effacée » (succès) de « refusée » (échec remonté à
 * l'opérateur, qui décide alors s'il purge quand même chez openedbot).
 */

type Sent = { path: string; method: string; kind: HermesRequestKind };

function fakeTransport(respond: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const transport: HermesTransport = {
    kind: "relay",
    async send(path, init, kind) {
      const entry: Sent = { path, method: (init.method ?? "GET").toUpperCase(), kind };
      sent.push(entry);
      return respond(entry);
    },
  };
  return { transport, sent };
}

describe("HermesClient.deleteSession", () => {
  test("DELETE /api/sessions/{id}, classé mutation", async () => {
    const { transport, sent } = fakeTransport(() =>
      Response.json({ object: "hermes.session.deleted", id: "openedbot:org-1:thread-1", deleted: true }));
    await new HermesClient({ transport }).deleteSession("openedbot:org-1:thread-1");
    expect(sent).toEqual([
      {
        path: "/api/sessions/openedbot%3Aorg-1%3Athread-1",
        method: "DELETE",
        kind: "mutation",
      },
    ]);
  });

  test("le profil du bot préfixe la route : une session créée sous /p/<slug> ne s'efface que là", async () => {
    const { transport, sent } = fakeTransport(() => new Response(null, { status: 204 }));
    await new HermesClient({ transport, profile: "prod-1" }).deleteSession("s-1");
    expect(sent[0]!.path).toBe("/p/prod-1/api/sessions/s-1");
  });

  test("un 404 est un succès : le contrat d'un DELETE est « elle n'existe plus »", async () => {
    const { transport } = fakeTransport(() => Response.json({ error: "not_found" }, { status: 404 }));
    expect(await new HermesClient({ transport }).deleteSession("s-1").then(() => "ok")).toBe("ok");
  });

  test("un connecteur trop ancien refuse la route AVANT le réseau, et l'échec remonte", async () => {
    // Ce que fait `createRelayTransport` quand la route n'est pas dans son
    // allowlist : rien n'est parti, et la purge ne doit surtout pas conclure
    // que la session a été effacée.
    const { transport, sent } = fakeTransport(() => {
      throw new HermesClientError(
        "Le lien connecteur ne relaie pas cette route Hermes.",
        403,
        "HERMES_LINK_PATH_FORBIDDEN",
        { requestDelivery: "not_sent" },
      );
    });
    const error = await new HermesClient({ transport })
      .deleteSession("s-1")
      .then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(HermesClientError);
    expect((error as HermesClientError).code).toBe("HERMES_LINK_PATH_FORBIDDEN");
    expect(sent).toHaveLength(1);
  });

  test("un 500 du gateway est un échec, jamais une purge silencieuse", async () => {
    const { transport } = fakeTransport(() => new Response("boom", { status: 500 }));
    const error = await new HermesClient({ transport })
      .deleteSession("s-1")
      .then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(HermesClientError);
    expect((error as HermesClientError).status).toBe(500);
  });
});

describe("HermesClient.removeSession", () => {
  test("says whether a session was there", async () => {
    const present = fakeTransport(() => Response.json({ object: "hermes.session.deleted", deleted: true }));
    expect(await new HermesClient({ transport: present.transport }).removeSession("openedbot:org-1:t-1")).toBe(true);
    const absent = fakeTransport(() => new Response(null, { status: 404 }));
    expect(await new HermesClient({ transport: absent.transport }).removeSession("openedbot:org-1:t-1")).toBe(false);
  });
});
