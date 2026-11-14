/**
 * Whether a database role keeps row-level security in force: shared by the
 * API and the worker before either hands a database handle to a plug-in.
 */
import type { Db } from "./db";

export type DbRoleAttributes = { role: string; superuser: boolean; bypassRls: boolean; ownsTables: boolean };

/**
 * The pool's role, and every role it is a member of, directly or through
 * other roles (`pg_auth_members`, followed transitively). A member can `SET
 * ROLE` to, or inherit the privileges of, any of them: an owner role among
 * them is as good as owning the tables.
 */
export type DbRoleFacts = DbRoleAttributes & { memberOf?: readonly DbRoleAttributes[] };

/**
 * What the pool's role may do, read once at boot when plug-ins are loaded.
 * Catalog reads only (`pg_roles`, `pg_auth_members`, `pg_class`).
 */
export async function readDbRoleFacts(db: Db): Promise<DbRoleFacts> {
  const rows = await db<Array<DbRoleAttributes & { current: boolean }>>`
    with recursive granted(roleid) as (
      select m.roleid from pg_auth_members m join pg_roles u on u.oid = m.member
       where u.rolname = current_user
      union
      select m.roleid from pg_auth_members m join granted g on m.member = g.roleid
    )
    select r.rolname as role, r.rolsuper as superuser, r.rolbypassrls as "bypassRls",
           exists (
             select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relowner = r.oid
           ) as "ownsTables",
           r.rolname = current_user as current
      from pg_roles r
     where r.rolname = current_user or r.oid in (select roleid from granted)
     order by r.rolname
  `;
  const self = rows.find((row) => row.current);
  if (!self) throw new Error("current_user has no pg_roles row");
  const strip = ({ role, superuser, bypassRls, ownsTables }: DbRoleAttributes): DbRoleAttributes => ({ role, superuser, bypassRls, ownsTables });
  return { ...strip(self), memberOf: rows.filter((row) => !row.current).map(strip) };
}

function attributeProblem(facts: DbRoleAttributes): string | null {
  if (facts.superuser) return "is a superuser";
  if (facts.bypassRls) return "has BYPASSRLS";
  if (facts.ownsTables) return "owns tables";
  return null;
}

/** `null` when the role keeps row-level security in force, else why not. */
export function tenantRoleProblem(facts: DbRoleFacts): string | null {
  const own = attributeProblem(facts);
  if (own) return `role ${facts.role} ${own}`;
  for (const granted of facts.memberOf ?? []) {
    const inherited = attributeProblem(granted);
    if (inherited) return `role ${facts.role} is a member of ${granted.role}, which ${inherited}`;
  }
  return null;
}
