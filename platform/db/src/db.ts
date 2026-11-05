import { isUuid } from "@openedbot/contracts-primitives";
import { SQL } from "bun";

export type Db = SQL;
export type TransactionDb = Bun.TransactionSQL;

export function createDatabase(url: string, maxConnections: number): Db {
  return new SQL({ url, max: maxConnections, idleTimeout: 30, connectionTimeout: 10 });
}

/**
 * Une transaction liée à une organisation, pour l'API comme pour le worker.
 *
 * Le worker traverse les organisations (file de runs, maintenance) et ses
 * policies historiques `using (true)` ne lisent pas `app.organization_id`.
 * Une table passée sous policy tenant pour `openedbot_worker` ne se lit plus qu'ici :
 * sans ce réglage, PostgreSQL ne rend aucune ligne, sans erreur. Chaque accès
 * converti passe donc par cette fonction, et `tests/integration/worker-tenant-scope.ts`
 * le prouve sur une vraie base.
 */
export async function withTenant<T>(
  db: Db,
  organizationId: string,
  callback: (tx: TransactionDb) => Promise<T>,
): Promise<T> {
  return db.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${organizationId}, true)`;
    return callback(tx);
  }) as Promise<T>;
}

export async function withCredential<T>(
  db: Db,
  credentialHash: string,
  callback: (tx: TransactionDb) => Promise<T>,
): Promise<T> {
  return db.begin(async (tx) => {
    await tx`select set_config('app.session_credential_hash', ${credentialHash}, true)`;
    return callback(tx);
  }) as Promise<T>;
}

export async function withAuthenticatingUser<T>(
  db: Db,
  userId: string,
  callback: (tx: TransactionDb) => Promise<T>,
): Promise<T> {
  return db.begin(async (tx) => {
    await tx`select set_config('app.authenticating_user_id', ${userId}, true)`;
    return callback(tx);
  }) as Promise<T>;
}

/**
 * Porte RLS d'une tentative OAuth publique. La valeur est toujours le SHA-256
 * d'un identifiant aléatoire ou d'un state, jamais le secret reçu du client.
 */
export async function withOauthLookup<T>(
  db: Db,
  lookupHash: string,
  callback: (tx: TransactionDb) => Promise<T>,
): Promise<T> {
  return db.begin(async (tx) => {
    await tx`select set_config('app.oauth_lookup_hash', ${lookupHash}, true)`;
    return callback(tx);
  }) as Promise<T>;
}

/**
 * Porte RLS du guichet de support. La valeur est toujours le SHA-256 du jeton
 * remis au visiteur, jamais le jeton : `support_conversations` compare cette
 * colonne, et un invité ne voit rien d'autre que son propre fil.
 *
 * Elle est posée AVANT l'ouverture d'une conversation, pas seulement avant sa
 * lecture : le `with check` de la policy est alors satisfait par construction.
 */
export async function withSupportGuest<T>(
  db: Db,
  tokenHash: string,
  callback: (tx: TransactionDb) => Promise<T>,
): Promise<T> {
  return db.begin(async (tx) => {
    await tx`select set_config('app.support_guest_token_hash', ${tokenHash}, true)`;
    return callback(tx);
  }) as Promise<T>;
}

/**
 * Porte COMPTE du guichet : les fils qu'un opérateur connecté a ouverts.
 *
 * Jumelle de `withSupportGuest`, avec une différence qui est tout l'intérêt :
 * le jeton est lié au navigateur, le compte ne l'est pas. L'identifiant vient
 * de `readOptionalSessionIdentity`, qui a validé la session en base (et son
 * jeton CSRF sur une méthode non sûre) ; il ne vient JAMAIS du corps de la
 * requête.
 */
export async function withSupportUser<T>(
  db: Db,
  userId: string,
  callback: (tx: TransactionDb) => Promise<T>,
): Promise<T> {
  return db.begin(async (tx) => {
    await tx`select set_config('app.support_user_id', ${userId}, true)`;
    return callback(tx);
  }) as Promise<T>;
}

/**
 * Bun range le SQLSTATE dans `errno` et met `ERR_POSTGRES_SERVER_ERROR` dans
 * `code` : un test sur le seul `code` ne reconnaît JAMAIS un conflit d'unicité.
 * Trois routes s'y fiaient : la collision de slug qui devait être rattrapée
 * sortait en échec de connexion ou en 500.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const details = error as { code?: unknown; errno?: unknown };
  return details.errno === "23505" || details.code === "23505";
}

/**
 * Noms lisibles extraits du `detail` Postgres (`Key (cols)=(vals)`), sinon
 * la liste de repli fournie par l'appelant (membres de l'import, etc.).
 */
export function uniqueViolationNames(error: unknown, fallback: readonly string[] = []): string[] {
  if (!(error instanceof Error)) return [...fallback];
  const extra = error as { detail?: unknown };
  const text = `${typeof extra.detail === "string" ? extra.detail : ""} ${error.message}`;
  const match = /\(([^)]+)\)=\(([^)]+)\)/.exec(text);
  if (!match) return [...fallback];
  const names = match[2]!.split(",").map((value) => value.trim()).filter((value) => value && !isUuid(value));
  return names.length > 0 ? names : [...fallback];
}

/** Missing relation: Bun puts SQLSTATE in `errno`, same as unique violations. */
export function isUndefinedTable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const details = error as { code?: unknown; errno?: unknown };
  return details.errno === "42P01" || details.code === "42P01";
}
