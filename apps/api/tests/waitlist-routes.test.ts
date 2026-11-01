import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { SQL } from "bun";
import type { ApiConfig } from "../src/infrastructure/config";
import { HttpError } from "../src/interfaces/http/http-error";
import type { EmailDomainVerdict } from "@openedbot/identity/application/email-domain-check";
import { waitlistRoutes } from "../src/routes/identity/waitlist-routes";

type FakeDbOptions = {
  calls: string[];
  bindings: unknown[][];
  inserted: boolean;
  outboxInserted?: boolean;
  transactions?: { value: number };
};

/**
 * Une seule transaction, puis les écritures de l'inscription, de son accusé
 * et du journal. Le
 * double enregistre ce que chaque `sql` a vu, dans l'ordre, pour que le test
 * puisse dire non seulement « les deux ont eu lieu » mais « la file n'a rien
 * reçu quand l'adresse était déjà là ».
 */
/**
 * Ce que rend un `insert` sans `returning` : aucune ligne, et le nombre de
 * lignes écrites porté par `count`, comme le `SQL` de Bun. La route ne lit que
 * ce compte, faute d'avoir le droit de relire ces deux tables (migration
 * 0065).
 */
function written(count: number): unknown[] {
  return Object.assign([] as unknown[], { count });
}

function fakeDb(options: FakeDbOptions): SQL {
  const query = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ").replace(/\s+/g, " ").trim();
    options.calls.push(sql);
    options.bindings.push(values);
    if (sql.includes("insert into waitlist_signups")) {
      return Promise.resolve(written(options.inserted ? 1 : 0));
    }
    if (sql.includes("insert into email_outbox_events")) {
      return Promise.resolve(written(1));
    }
    if (sql.includes("insert into email_outbox")) {
      return Promise.resolve(written(options.outboxInserted === false ? 0 : 1));
    }
    return Promise.resolve(written(0));
  }) as unknown as SQL;
  (query as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (inner: SQL) => unknown) => {
      if (options.transactions) options.transactions.value += 1;
      return callback(query);
    };
  return query;
}

/** L'origine de la PWA : elle ne sert qu'aux liens légaux du pied de page. */
const config = { webUrl: "https://console.openedbot.app" } as unknown as ApiConfig;

/** Le DNS n'est jamais consulté dans un test unitaire : le verdict est donné. */
function mount(db: SQL, verdict: EmailDomainVerdict = "deliverable", seen?: string[]): Hono {
  const app = new Hono();
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED", message: String(error) } }, 500));
  app.route("/", waitlistRoutes(db, config, async (domain) => {
    seen?.push(domain);
    return verdict;
  }));
  return app;
}

function post(app: Hono, body: unknown) {
  return app.request("/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("POST /api/waitlist", () => {
  test("inscrit une adresse normalisée avec la langue de la page", async () => {
    const calls: string[] = [];
    const bindings: unknown[][] = [];
    const response = await post(mount(fakeDb({ calls, bindings, inserted: true })), { email: "  Kev@Example.com ", locale: "fr" });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ status: "joined" });
    expect(calls[0]).toContain("insert into waitlist_signups (id, email, locale)");
    // Sans cible et sans `returning` : `ohb_api` n'a que l'insertion sur cette
    // table (migration 0065), et les deux formes contraires exigeraient un
    // droit de lecture sur des adresses en clair.
    expect(calls[0]).toContain("on conflict do nothing");
    expect(calls[0]).not.toContain("returning");
    expect(bindings[0]?.slice(1)).toEqual(["kev@example.com", "fr"]);
  });

  test("une adresse déjà inscrite répond already sans erreur", async () => {
    const response = await post(mount(fakeDb({ calls: [], bindings: [], inserted: false })), { email: "kev@example.com", locale: "xx" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "already" });
  });

  test("refuse ce qui n'est pas une adresse, sans écrire ni résoudre", async () => {
    const calls: string[] = [];
    const seen: string[] = [];
    for (const email of ["kev", "@example.com", "kev@", "kev @example.com", "a@b@c", "a@b", "kev@localhost", "kev@example.c"]) {
      const response = await post(mount(fakeDb({ calls, bindings: [], inserted: true }), "deliverable", seen), { email });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "WAITLIST_EMAIL_INVALID" } });
    }
    // Un champ vide est un champ manquant, pas une adresse mal écrite : c'est
    // `assertString` qui tranche, avant même la forme.
    const empty = await post(mount(fakeDb({ calls, bindings: [], inserted: true }), "deliverable", seen), { email: "" });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: { code: "VALIDATION_ERROR" } });

    expect(calls).toEqual([]);
    expect(seen).toEqual([]);
  });

  test("refuse une adresse jetable, sans écrire ni résoudre", async () => {
    const calls: string[] = [];
    const seen: string[] = [];
    for (const email of ["kev@yopmail.com", "kev@boite.mailinator.com", "kev@grr.la"]) {
      const response = await post(mount(fakeDb({ calls, bindings: [], inserted: true }), "deliverable", seen), { email });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "WAITLIST_EMAIL_DISPOSABLE" } });
    }
    // La liste tranche sans réseau : le DNS n'est même pas sollicité.
    expect(seen).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("refuse un domaine qui ne reçoit pas de courrier", async () => {
    const calls: string[] = [];
    const seen: string[] = [];
    const response = await post(
      mount(fakeDb({ calls, bindings: [], inserted: true }), "unknown_domain", seen),
      { email: "kev@domaine-inexistant.fr" },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "WAITLIST_EMAIL_DOMAIN_UNKNOWN" } });
    expect(seen).toEqual(["domaine-inexistant.fr"]);
    expect(calls).toEqual([]);
  });

  test("une résolution qui échoue laisse passer : une panne DNS ne perd pas d'inscription", async () => {
    const calls: string[] = [];
    const response = await post(
      mount(fakeDb({ calls, bindings: [], inserted: true }), "unverified"),
      { email: "kev@example.com" },
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ status: "joined" });
    expect(calls).toHaveLength(3);
  });

  test("l'accusé part dans la même transaction que l'inscription", async () => {
    const calls: string[] = [];
    const bindings: unknown[][] = [];
    const transactions = { value: 0 };
    await post(mount(fakeDb({ calls, bindings, inserted: true, transactions })), { email: "kev@example.com", locale: "en" });
    expect(transactions.value).toBe(1);
    expect(calls).toHaveLength(3);
    expect(calls[1]).toContain("insert into email_outbox");
    expect(calls[1]).toContain("on conflict do nothing");
    expect(calls[1]).not.toContain("returning");
    expect(calls[2]).toContain("insert into email_outbox_events");
  });

  test("une adresse déjà inscrite ne redépose aucun accusé", async () => {
    const calls: string[] = [];
    await post(mount(fakeDb({ calls, bindings: [], inserted: false })), { email: "kev@example.com", locale: "fr" });
    expect(calls).toHaveLength(1);
    expect(calls.some((sql) => sql.includes("email_outbox"))).toBe(false);
  });

  test("sans langue lisible, l'accusé part en français", async () => {
    const bindings: unknown[][] = [];
    await post(mount(fakeDb({ calls: [], bindings, inserted: true })), { email: "kev@example.com" });
    expect(bindings[1]?.[4]).toBe("fr");
  });

  test("une inscription neuve déduit la clé de l'identifiant généré, jamais de l'adresse", async () => {
    const calls: string[] = [];
    const bindings: unknown[][] = [];
    const response = await post(
      mount(fakeDb({ calls, bindings, inserted: true })),
      { email: "kev@example.com", locale: "fr" },
    );

    expect(response.status).toBe(201);
    const signupId = bindings[0]?.[0];
    expect(typeof signupId).toBe("string");
    expect(String(signupId)).toMatch(/^[0-9a-f-]{36}$/u);
    expect(bindings[1]?.[2]).toBe(`waitlist:${signupId}`);
    expect(String(bindings[1]?.[2])).not.toContain("kev@example.com");
    expect(bindings[2]?.slice(1, 4)).toEqual(["waitlist_confirmation", "queued", null]);
  });

  test("un dépôt sans ligne journalise le doublon et répond quand même joined", async () => {
    const calls: string[] = [];
    const bindings: unknown[][] = [];
    const response = await post(
      mount(fakeDb({ calls, bindings, inserted: true, outboxInserted: false })),
      { email: "kev@example.com", locale: "fr" },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ status: "joined" });
    expect(calls[2]).toContain("insert into email_outbox_events");
    expect(bindings[2]).toEqual([
      null,
      "waitlist_confirmation",
      "duplicate_skipped",
      null,
      { domain: "example.com" },
    ]);
  });
});
