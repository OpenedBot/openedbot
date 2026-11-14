import type { SQL } from "bun";

/**
 * Une base factice qui tient `audit_chain` en mémoire (append-only : aucune
 * requête de mise à jour n'y est servie), plus les lignes d'audit d'avant la
 * chaîne pour le backfill. `begin` annule ce qui a été ajouté si le callback lève.
 */
export type ChainRow = {
  organizationId: string; runtimeId: string; seq: number; kind: string; objectKey: string;
  payload: Record<string, unknown>; payloadSha256: string; prevHash: string | null; hash: string;
};

export type ChainDbOptions = {
  verifications?: Array<Record<string, unknown>>;
  anchors?: Array<Record<string, unknown>>;
  /** Réponses aux autres requêtes (ancres, clés, événements). */
  other?: (sql: string, values: unknown[]) => unknown[] | undefined;
};

export function chainDb(options: ChainDbOptions = {}) {
  const rows: ChainRow[] = [];
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join("?").replace(/\s+/g, " ").trim();
    statements.push({ sql, values });
    if (sql.includes("pg_advisory_xact_lock")) return [];
    if (/update audit_chain|delete from audit_chain/.test(sql)) throw new Error("audit_chain is append-only");
    if (sql.includes("insert into audit_chain")) {
      const [organizationId, runtimeId, seq, kind, objectKey, payload, payloadSha256, prevHash, hash] = values as [string, string, number, string, string, Record<string, unknown>, string, string | null, string];
      if (rows.some((row) => row.runtimeId === runtimeId && (row.seq === seq || row.objectKey === objectKey))) throw new Error("duplicate key");
      // Comme jsonb : une copie, pas la référence de l'appelant.
      rows.push({ organizationId, runtimeId, seq, kind, objectKey, payload: JSON.parse(JSON.stringify(payload)), payloadSha256, prevHash, hash });
      return [];
    }
    if (sql.includes("from audit_chain where runtime_id = ? and object_key = ?")) {
      return rows.filter((row) => row.runtimeId === values[0] && row.objectKey === values[1])
        .map(({ seq, hash, payload, payloadSha256 }) => ({ seq: String(seq), hash, payload: JSON.parse(JSON.stringify(payload)), payloadSha256 }));
    }
    if (sql.includes("from audit_chain where runtime_id = ? order by seq desc limit 1")) {
      const last = rows.filter((row) => row.runtimeId === values[0]).sort((a, b) => b.seq - a.seq)[0];
      return last ? [{ seq: String(last.seq), hash: last.hash }] : [];
    }
    if (sql.includes("from audit_chain where organization_id = ? and runtime_id = ?")) {
      return rows.filter((row) => row.organizationId === values[0] && row.runtimeId === values[1]).sort((a, b) => a.seq - b.seq)
        .map(({ seq, kind, objectKey, payload, payloadSha256, prevHash, hash }) => ({ seq: String(seq), kind, objectKey, payload: JSON.parse(JSON.stringify(payload)), payloadSha256, prevHash, hash }));
    }
    if (sql.includes("from runtime_audit_verifications")) return options.verifications ?? [];
    if (sql.includes("from runtime_audit_anchors") && sql.startsWith("select key_id")) return options.anchors ?? [];
    return options.other?.(sql, values) ?? [];
  }) as unknown as SQL;
  const db = {
    begin: async (callback: (inner: Bun.TransactionSQL) => Promise<unknown>) => {
      const before = rows.length;
      try {
        return await callback(tx as unknown as Bun.TransactionSQL);
      } catch (error) {
        rows.length = before;
        throw error;
      }
    },
  } as unknown as SQL;
  return { db, tx: tx as unknown as Bun.TransactionSQL, rows, statements };
}
