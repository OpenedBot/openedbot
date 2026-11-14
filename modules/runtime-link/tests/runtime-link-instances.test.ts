import { describe, expect, test } from "bun:test";
import { sweepDisconnectedRuntimeLinks } from "../src/application/runtime-links";

type Captured = { sql: string; values: unknown[] };

function fakeDb(captured: Captured[]): Bun.SQL {
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    captured.push({ sql: [...strings].join("?"), values });
    return Promise.resolve([{ count: 0 }]);
  }) as unknown as Bun.SQL;
}

describe("balayage disconnected instance-aware", () => {
  test("sweepDisconnectedRuntimeLinks joint api_instances et épargne une instance vivante au last_seen frais", async () => {
    const captured: Captured[] = [];
    await sweepDisconnectedRuntimeLinks(fakeDb(captured));
    expect(captured).toHaveLength(1);
    const sql = captured[0]!.sql;
    expect(sql).toContain("from api_instances inst");
    expect(sql).toContain("interval '45 seconds'");
    expect(sql).toContain("interval '60 seconds'");
    expect(sql).toContain("inst.stopped_at is null");
    expect(sql).toContain("and not (");
    expect(sql).toContain("link_last_seen_at > now() - interval '45 seconds'");
    // L'écran Runtime lit la raison dans `last_health_error`, écrite avec le statut.
    expect(sql).toContain("last_health_error = case");
    expect(sql).toContain("'Aucun signe de vie du lien depuis 45 s.'");
  });

});
