import type { SQL } from "bun";

/**
 * Rejouer l'accueil à vide, en développement UNIQUEMENT : la base locale perd
 * ses données applicatives, mais garde la « partie utilisateur » : on reste
 * connecté sans se reloguer.
 *
 * Deux chemins l'appellent, et cette liste est la seule qui existe :
 * `POST /api/onboarding/reset` avec `{"scope":"full"}`
 * (`interfaces/http/misc-routes.ts`) et `make db-reset-keep-users`
 * (`apps/api/scripts/dev-reset-data.ts`).
 */

/**
 * Ce que le vidage NE touche pas. Chaque ligne est une raison, pas une
 * préférence :
 *
 * - `users`, `memberships`, `sessions` : la session en cours vit là.
 *   `sessions` porte une FK `(organization_id, user_id)` vers `memberships`,
 *   et l'authentification résout l'organisation par cette jointure : vider
 *   `memberships` ou `organizations` déconnecte la personne, ce que la demande
 *   interdit explicitement.
 * - `organizations` : la LIGNE reste (les sessions en dépendent) ; seuls
 *   `onboarding` et `onboarded_at` sont remis à NULL, plus bas.
 * - `staff_users`, `staff_sessions` : la même chose pour le backoffice staff.
 * - `schema_migrations` : la vider ferait rejouer toutes les migrations.
 * - `subscriptions` : l'abonnement est l'état du COMPTE, pas une production de
 *   l'accueil. En développement `BILLING_ENFORCED` est faux par défaut et
 *   l'absence d'abonnement dégrade en « illimité » (`@openedbot/identity/domain/entitlement`,
 *   `member-routes.ts`, `conversation-routes.ts`) : mais avec
 *   `BILLING_ENFORCED=true` en dev, perdre la ligne renvoie 402/403 sur tout
 *   l'espace et rend justement le nouvel accueil injouable. Le recréer ici
 *   dupliquerait les valeurs de plan de `apps/api/scripts/seed.ts` ; on le
 *   garde, il survit intact à la ligne `organizations` préservée.
 * - `runtimes` et ce qui rattache un runtime à son lien (`runtime_audit_keys`,
 *   `runtime_audit_anchors`, `runtime_direct_exposures`,
 *   `runtime_review_profiles`) : la machine de dev reste reliée. Le connecteur
 *   du VPS garde son jeton de lien ; sans la ligne `runtimes`, chaque
 *   reconnexion serait refusée jusqu'à un nouvel appairage, et l'étape
 *   Configuration de l'accueil retrouve ainsi la machine prête. Ces tables ne
 *   référencent que `organizations`, `runtimes` et `users`, toutes gardées :
 *   la garde de cascade ci-dessous le vérifie. Les bots, profils, routines et
 *   runs qui les référencent, eux, sont vidés.
 * - `api_instances`, `service_instances` : registres des PROCESSUS vivants
 *   (heartbeat, `runtimes.link_instance_id`), déclarés « tables
 *   d'exploitation, hors RLS tenant, aucun identifiant de client » par
 *   `migrations/0040_api_instances.sql`. Les vider pendant que `make dev`
 *   tourne casse le routage du lien connecteur jusqu'au heartbeat suivant.
 */
export const DEV_RESET_PRESERVED_TABLES: readonly string[] = [
  "users",
  "organizations",
  "memberships",
  // L'accès d'une agence à un client (0086) est de la même nature qu'une
  // membership : le vider couperait une session agence ouverte chez un client.
  "agency_grants",
  "agency_client_invitations",
  "sessions",
  "staff_users",
  "staff_sessions",
  "schema_migrations",
  "subscriptions",
  "api_instances",
  "service_instances",
  "runtimes",
  "runtime_audit_keys",
  "runtime_audit_anchors",
  "runtime_direct_exposures",
  "runtime_review_profiles",
];

export const DEV_RESET_SCHEMA = "public";

/** Identifiant SQL nu : rien d'autre n'est interpolé dans un `truncate`. */
const PLAIN_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Bun sérialise un tableau JS en « a,b,c » : Postgres refuse ce littéral pour
 * un `text[]`. Le littéral est donc construit ici, à partir d'identifiants nus
 * déjà validés : jamais de guillemet ni de virgule à échapper.
 */
function pgTextArray(values: readonly string[]): string {
  const suspicious = values.filter((value) => !PLAIN_IDENTIFIER.test(value));
  if (suspicious.length > 0) {
    throw new Error(`Table au nom non citable, vidage refusé : ${suspicious.join(", ")}.`);
  }
  return `{${values.join(",")}}`;
}

const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "::1", "[::1]"];

export type DevResetReport = {
  truncatedTables: string[];
  preservedTables: string[];
  organizationsReset: number;
  usersReset: number;
};

/**
 * Garde-fou. Deux conditions, toutes deux nécessaires : l'environnement est
 * `development`, et la base visée est locale (boucle locale). Le test de
 * localité porte sur l'hôte de la DSN, pas sur son nom : une DSN de préprod
 * nommée « ohb » est refusée, et `localhost` reste accepté.
 */
export function assertDevResetAllowed(input: { environment: string; databaseUrl: string }): void {
  if (input.environment !== "development") {
    throw new Error(`Le vidage de développement est refusé hors development (OHB_ENV=${input.environment}).`);
  }
  let host: string;
  let database: string;
  try {
    const url = new URL(input.databaseUrl);
    host = url.hostname;
    database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    throw new Error("La DSN du vidage de développement est illisible.");
  }
  if (!LOOPBACK_HOSTS.includes(host)) {
    throw new Error(`Le vidage de développement est refusé hors base locale (hôte ${host}).`);
  }
  if (database === "" || !PLAIN_IDENTIFIER.test(database)) {
    throw new Error(`Le vidage de développement refuse le nom de base « ${database} ».`);
  }
  if (["postgres", "template0", "template1"].includes(database)) {
    throw new Error(`Le vidage de développement refuse la base système « ${database} ».`);
  }
}

/**
 * La liste des tables à vider est DÉRIVÉE du schéma réel, jamais figée : la
 * prochaine migration qui ajoute une table est vidée sans qu'on y pense, et
 * une table renommée ne laisse pas une entrée morte derrière elle.
 */
export async function resolveDevResetTables(sql: SQL): Promise<string[]> {
  const rows = await sql<Array<{ name: string }>>`
    select table_name as name from information_schema.tables
     where table_schema = ${DEV_RESET_SCHEMA}
       and table_type = 'BASE TABLE'
       and table_name <> all(${pgTextArray(DEV_RESET_PRESERVED_TABLES)}::text[])
     order by table_name
  `;
  const names = rows.map((row) => row.name);
  const suspicious = names.filter((name) => !PLAIN_IDENTIFIER.test(name));
  if (suspicious.length > 0) {
    throw new Error(`Table au nom non citable, vidage refusé : ${suspicious.join(", ")}.`);
  }
  return names;
}

/**
 * `truncate ... cascade` remonte vers les tables qui RÉFÉRENCENT une table
 * vidée. Si une table préservée référençait une table vidée, la cascade la
 * viderait en silence : la session serait perdue sans un mot. On le vérifie au
 * lieu de l'espérer.
 */
async function assertCascadeStaysAwayFromPreserved(sql: SQL, truncated: readonly string[]): Promise<void> {
  const rows = await sql<Array<{ child: string; parent: string }>>`
    select distinct c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent
      from pg_constraint c
     where c.contype = 'f'
       and c.conrelid::regclass::text = any(${pgTextArray(DEV_RESET_PRESERVED_TABLES)}::text[])
       and c.confrelid::regclass::text = any(${pgTextArray(truncated)}::text[])
  `;
  if (rows.length > 0) {
    const pairs = rows.map((row) => `${row.child} -> ${row.parent}`).join(", ");
    throw new Error(`Une table préservée référence une table vidée, la cascade l'emporterait : ${pairs}.`);
  }
}

/**
 * Le vidage lui-même, en une transaction. Il ne prend NI utilisateur NI
 * organisation : c'est la base locale entière qui repart à zéro, exactement
 * comme la cible `make`. Le flag d'accueil retombe donc pour toute personne
 * connectée, ce que `apps/console/src/lib/onboarding-gate.ts` lit comme le seul
 * déclencheur du parcours.
 */
export async function performDevDataReset(sql: SQL): Promise<DevResetReport> {
  const tables = await resolveDevResetTables(sql);
  await assertCascadeStaysAwayFromPreserved(sql, tables);
  return (await sql.begin(async (tx) => {
    if (tables.length > 0) {
      const list = tables.map((name) => `"${name}"`).join(", ");
      await tx.unsafe(`truncate table ${list} restart identity cascade`);
    }
    const organizations = await tx<Array<{ id: string }>>`
      update organizations set onboarding = null, onboarded_at = null, updated_at = now()
       where onboarding is not null or onboarded_at is not null
       returning id
    `;
    const users = await tx<Array<{ id: string }>>`
      update users set onboarding_completed = false, updated_at = now()
       where onboarding_completed returning id
    `;
    return {
      truncatedTables: tables,
      preservedTables: [...DEV_RESET_PRESERVED_TABLES],
      organizationsReset: organizations.length,
      usersReset: users.length,
    };
  })) as DevResetReport;
}
