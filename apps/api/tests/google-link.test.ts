import { describe, expect, test } from "bun:test";
import type { Db } from "@openedbot/platform-db";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { linkGoogleIdentity } from "@openedbot/identity/application/google-link";
import { resolveGoogleIdentity } from "@openedbot/identity/application/google-identity";

const IDENTITY = { subject: "google-sub-1", email: "kev@example.com", displayName: "Kev" };

type Fixture = {
  calls: string[];
  account?: { email: string; googleSubject: string | null; passwordHash: string | null } | null;
  subjectOwner?: string | null;
  uniqueViolation?: boolean;
  resolved?: { id: string; email: string; displayName: string | null; linkedBySubject: boolean; googleUnlinked: boolean } | null;
};

function fakeDb(fixture: Fixture): Db {
  return ((strings: TemplateStringsArray) => {
    const sql = [...strings].join(" ").replace(/\s+/g, " ").trim();
    fixture.calls.push(sql);
    if (sql.includes("google_subject as \"googleSubject\"")) {
      return Promise.resolve(fixture.account ? [fixture.account] : []);
    }
    if (sql.startsWith("select id from users where google_subject")) {
      return Promise.resolve(fixture.subjectOwner ? [{ id: fixture.subjectOwner }] : []);
    }
    if (sql.startsWith("update users set google_subject")) {
      if (fixture.uniqueViolation) return Promise.reject(Object.assign(new Error("duplicate key"), { code: "23505" }));
      return Promise.resolve([]);
    }
    if (sql.includes("\"googleUnlinked\"")) {
      return Promise.resolve(fixture.resolved ? [fixture.resolved] : []);
    }
    return Promise.resolve([]);
  }) as unknown as Db;
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof HttpError ? error.code : String(error);
  }
}

describe("linkGoogleIdentity", () => {
  test("lie le compte Google de la même adresse et rouvre l'entrée par adresse", async () => {
    const calls: string[] = [];
    const db = fakeDb({ calls, account: { email: "Kev@Example.com", googleSubject: null, passwordHash: "hash" } });
    expect(await codeOf(linkGoogleIdentity(db, "user-1", IDENTITY))).toBeNull();
    expect(calls.some((sql) => sql.includes("google_unlinked_at = null"))).toBe(true);
  });

  test("refuse un compte Google d'une autre adresse, sans écrire", async () => {
    const calls: string[] = [];
    const db = fakeDb({ calls, account: { email: "other@example.com", googleSubject: null, passwordHash: "hash" } });
    expect(await codeOf(linkGoogleIdentity(db, "user-1", IDENTITY))).toBe("GOOGLE_EMAIL_MISMATCH");
    expect(calls.some((sql) => sql.startsWith("update users"))).toBe(false);
  });

  test("refuse un compte Google déjà porté par un autre utilisateur", async () => {
    const calls: string[] = [];
    const db = fakeDb({
      calls,
      account: { email: "kev@example.com", googleSubject: null, passwordHash: "hash" },
      subjectOwner: "user-2",
    });
    expect(await codeOf(linkGoogleIdentity(db, "user-1", IDENTITY))).toBe("GOOGLE_ALREADY_LINKED");
  });

  test("la contrainte unique perdue en course se dit GOOGLE_ALREADY_LINKED", async () => {
    const calls: string[] = [];
    const db = fakeDb({
      calls,
      account: { email: "kev@example.com", googleSubject: null, passwordHash: "hash" },
      uniqueViolation: true,
    });
    expect(await codeOf(linkGoogleIdentity(db, "user-1", IDENTITY))).toBe("GOOGLE_ALREADY_LINKED");
  });
});

describe("resolveGoogleIdentity après une déliaison", () => {
  test("un compte délié, retrouvé par sa seule adresse, est refusé sans écriture", async () => {
    const calls: string[] = [];
    const db = fakeDb({
      calls,
      resolved: { id: "user-1", email: "kev@example.com", displayName: null, linkedBySubject: false, googleUnlinked: true },
    });
    expect(await codeOf(resolveGoogleIdentity(db, IDENTITY))).toBe("AUTH_GOOGLE_UNLINKED");
    expect(calls.some((sql) => sql.startsWith("update users"))).toBe(false);
  });

  test("un compte relié depuis (retrouvé par son sub) entre normalement", async () => {
    const calls: string[] = [];
    const db = fakeDb({
      calls,
      resolved: { id: "user-1", email: "kev@example.com", displayName: null, linkedBySubject: true, googleUnlinked: false },
    });
    // Ni porte ni refus : l'échec éventuel vient de la suite (organisation), pas de la déliaison.
    expect(await codeOf(resolveGoogleIdentity(db, IDENTITY))).not.toBe("AUTH_GOOGLE_UNLINKED");
    expect(calls.some((sql) => sql.startsWith("update users set google_subject"))).toBe(true);
  });
});
