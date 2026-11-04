import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { evaluateRuntimeLinkAlerts } from "../src/application/link-alerts";

/**
 * Les destinataires d'une alerte de lien : l'utilisateur qui a appairé le
 * runtime et les owners/admins, TOUS membres actifs de l'organisation. Base
 * factice : une alerte s'ouvre, la requête des destinataires est capturée.
 */
describe("destinataires des alertes du lien connecteur", () => {
  test("l'utilisateur concerné ne reçoit rien sans membership actif", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = [...strings].join("?").replace(/\s+/g, " ").trim();
      statements.push({ sql, values });
      if (sql.startsWith("insert into runtime_link_alerts")) {
        return [{ id: "alert-1", organizationId: "org-1", runtimeName: "Mac", reason: null, downSince: new Date(), concernedUserId: "user-paired", recent: true }];
      }
      return [];
    }) as unknown as SQL;
    const db = { begin: (callback: (inner: SQL) => Promise<unknown>) => callback(tx) } as unknown as SQL;
    await evaluateRuntimeLinkAlerts(db, { downAfterMinutes: 5, webAppUrl: "https://app.test", environment: "test" });
    const recipients = statements.find((entry) => entry.sql.includes("from users u"))!;
    expect(recipients.sql).toContain("join memberships m on m.user_id = u.id and m.organization_id = ? and m.revoked_at is null");
    expect(recipients.sql).toContain("(u.id = ? or m.role in ('owner', 'admin'))");
    // L'appairage n'ouvre plus aucune voie hors du membership.
    expect(recipients.sql).not.toContain("u.id in (");
    expect(recipients.values).toEqual(["org-1", "user-paired"]);
  });
});
