/**
 * The row an `insert into <table> (columns) values (...)` writes, read from a
 * statement captured by a fake SQL tag: column name → bound value. It holds for
 * the creation primitives of `modules/execution/src/sql/run-writes.ts`, which
 * bind exactly one placeholder per column, in the order of the column list
 * (`deadline_at` binds its number of seconds).
 */
export function insertedRow(sql: string, values: readonly unknown[]): Record<string, unknown> {
  const match = /insert\s+into\s+[a-z_.]+\s*\(([^)]*)\)/iu.exec(sql);
  if (!match) throw new Error(`not an insert with a column list: ${sql.slice(0, 80)}`);
  const columns = match[1]!.split(",").map((column) => column.trim()).filter(Boolean);
  if (columns.length !== values.length) {
    throw new Error(`${columns.length} columns but ${values.length} values: not a one-placeholder-per-column insert`);
  }
  return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
}
