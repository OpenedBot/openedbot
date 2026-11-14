import { describe, expect, test } from "bun:test";
import { createEmailDomainChecker, type EmailDomainVerdict } from "../src/application/email-domain-check";
import { isDisposableEmailDomain } from "../src/domain/disposable-email-domains";

function checkerOver(answers: Record<string, EmailDomainVerdict>, calls: string[], now = () => 0) {
  return createEmailDomainChecker(async (domain) => {
    calls.push(domain);
    return answers[domain] ?? "unknown_domain";
  }, now);
}

describe("createEmailDomainChecker", () => {
  test("normalise le domaine avant de le résoudre", async () => {
    const calls: string[] = [];
    const check = checkerOver({ "example.com": "deliverable" }, calls);
    expect(await check("  Example.COM ")).toBe("deliverable");
    expect(calls).toEqual(["example.com"]);
  });

  test("met en cache un verdict, pas une panne", async () => {
    const calls: string[] = [];
    const check = checkerOver({ "example.com": "deliverable", "panne.test": "unverified" }, calls);

    expect(await check("example.com")).toBe("deliverable");
    expect(await check("example.com")).toBe("deliverable");
    expect(calls.filter((domain) => domain === "example.com")).toHaveLength(1);

    // Une résolution qui n'a pas abouti ne fige rien : la fois suivante redemande.
    expect(await check("panne.test")).toBe("unverified");
    expect(await check("panne.test")).toBe("unverified");
    expect(calls.filter((domain) => domain === "panne.test")).toHaveLength(2);
  });

  test("le verdict expire, positif comme négatif", async () => {
    const calls: string[] = [];
    let clock = 0;
    const check = checkerOver({ "example.com": "deliverable", "absent.test": "unknown_domain" }, calls, () => clock);

    await check("example.com");
    await check("absent.test");
    expect(calls).toHaveLength(2);

    // 11 minutes : le négatif est périmé, le positif tient encore (6 h).
    clock = 11 * 60 * 1_000;
    await check("example.com");
    await check("absent.test");
    expect(calls.filter((domain) => domain === "example.com")).toHaveLength(1);
    expect(calls.filter((domain) => domain === "absent.test")).toHaveLength(2);

    clock = 7 * 60 * 60 * 1_000;
    await check("example.com");
    expect(calls.filter((domain) => domain === "example.com")).toHaveLength(2);
  });
});

describe("isDisposableEmailDomain", () => {
  test("reconnaît les services jetables, sous-domaines compris", () => {
    for (const domain of ["yopmail.com", "YopMail.COM", "mailinator.com", "boite.yopmail.com", "grr.la"]) {
      expect(isDisposableEmailDomain(domain)).toBe(true);
    }
  });

  test("laisse passer les fournisseurs réels", () => {
    for (const domain of [
      "gmail.com",
      "laposte.net",
      "free.fr",
      "orange.fr",
      "outlook.com",
      "proton.me",
      "openedbot.app",
      // Un domaine qui CONTIENT le nom d'un jetable sans en être un sous-domaine.
      "notyopmail.com",
      "yopmail.com.example.fr",
    ]) {
      expect(isDisposableEmailDomain(domain)).toBe(false);
    }
  });
});
