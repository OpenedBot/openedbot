/**
 * A route's own window, plus optionally a budget it SHARES with other routes:
 * a request passes only if both have room, and counts in both. The routes that
 * email a sign-in code keep their own limits and also draw on one per-IP
 * issuance budget, so adding a code path never widens another route's limit.
 */
export type RateBudget = { name: string; windowMs: number; max: number };
export type RateRule = { windowMs: number; max: number; shared?: RateBudget };

const SWEEP_INTERVAL_MS = 60_000;

export type RateLimitVerdict = { limited: false } | { limited: true; retryAfterSeconds: number };

export type RateLimitGate = {
  /** `method` + `path` + IP → laisser passer, ou refuser avec le délai à annoncer. */
  check(method: string, path: string, ip: string, now?: number): RateLimitVerdict;
};

/**
 * Fenêtre fixe par règle et par IP, plus le budget partagé de la règle s'il y
 * en a un. Un même nom de budget porte la même fenêtre et le même plafond
 * partout : une divergence est une erreur de configuration, levée ici.
 */
export function createRateLimitGate(rules: Record<string, RateRule>): RateLimitGate {
  const budgets = new Map<string, RateBudget>();
  for (const [route, rule] of Object.entries(rules)) {
    if (!rule.shared) continue;
    const known = budgets.get(rule.shared.name);
    if (known && (known.windowMs !== rule.shared.windowMs || known.max !== rule.shared.max)) {
      throw new Error(`Rate limit budget ${rule.shared.name} has mismatched windows, including ${route}`);
    }
    budgets.set(rule.shared.name, rule.shared);
  }
  const buckets = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = 0;
  return {
    check(method, path, ip, now = Date.now()) {
      const match = findRule(rules, method, path);
      if (!match) return { limited: false };
      const { rule, bucketPath } = match;

      if (now - lastSweep >= SWEEP_INTERVAL_MS) {
        for (const [key, bucket] of buckets) if (now >= bucket.resetAt) buckets.delete(key);
        lastSweep = now;
      }

      // Wildcard routes share one bucket: changing a thread/run id must not
      // provide an unbounded set of fresh write buckets for the same client.
      const windows: Array<{ key: string; windowMs: number; max: number }> = [
        { key: `${method} ${bucketPath}:${ip}`, windowMs: rule.windowMs, max: rule.max },
      ];
      if (rule.shared) {
        windows.push({ key: `shared ${rule.shared.name}:${ip}`, windowMs: rule.shared.windowMs, max: rule.shared.max });
      }
      let retryAfterMs = 0;
      for (const window of windows) {
        const bucket = buckets.get(window.key);
        if (bucket && now < bucket.resetAt && bucket.count >= window.max) {
          retryAfterMs = Math.max(retryAfterMs, bucket.resetAt - now);
        }
      }
      if (retryAfterMs > 0) return { limited: true, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };
      for (const window of windows) {
        const bucket = buckets.get(window.key);
        if (!bucket || now >= bucket.resetAt) buckets.set(window.key, { count: 1, resetAt: now + window.windowMs });
        else bucket.count += 1;
      }
      return { limited: false };
    },
  };
}

function findRule(
  rules: Record<string, RateRule>,
  method: string,
  path: string,
): { rule: RateRule; bucketPath: string } | undefined {
  const exact = rules[`${method} ${path}`];
  if (exact) return { rule: exact, bucketPath: path };
  for (const [pattern, rule] of Object.entries(rules)) {
    const [patternMethod, patternPath] = pattern.split(/ (.*)/s);
    if (patternMethod !== method || !patternPath?.includes("*")) continue;
    const escaped = patternPath.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
    if (new RegExp(`^${escaped}$`).test(path)) return { rule, bucketPath: patternPath };
  }
  return undefined;
}

/** La même règle, pour une requête servie hors de Hono (montée WebSocket). */
export function requestClientIp(
  request: Request,
  server: { requestIP?: (request: Request) => { address: string } | null } | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded) {
      const hops = forwarded.split(",").map((hop) => hop.trim()).filter(Boolean);
      const last = hops[hops.length - 1];
      if (last) return last;
    }
  }
  return server?.requestIP?.(request)?.address ?? "unknown";
}

/** Clé de règle de la montée WebSocket du lien connecteur (`GET /api/runtime-links/ws`). */
export const RUNTIME_LINK_UPGRADE_RULE = "GET /api/runtime-links/ws";

/**
 * One per-IP budget for every route that emails a sign-in code: the code
 * request itself and the two password doors, which now issue a code before
 * they open a session. A password sign-in is two calls (code, then code
 * check), so ten leaves about five sign-ins per IP per minute; the
 * per-address 60 s cooldown still holds on top.
 */
export const AUTH_EMAIL_CODE_BUDGET: RateBudget = { name: "auth-email-code", windowMs: 60_000, max: 10 };

/** Fenêtres par défaut sur les routes non authentifiées les plus attaquées. */
export const AUTH_RATE_RULES: Record<string, RateRule> = {
  "POST /api/auth/login/code": { windowMs: 60_000, max: 5, shared: AUTH_EMAIL_CODE_BUDGET },
  "POST /api/auth/login/code/verify": { windowMs: 60_000, max: 10 },
  "POST /api/auth/login": { windowMs: 60_000, max: 10, shared: AUTH_EMAIL_CODE_BUDGET },
  "POST /api/auth/native/authorize": { windowMs: 60_000, max: 20, shared: AUTH_EMAIL_CODE_BUDGET },
  // The desktop's passwordless door checks a code like the web one: same
  // ceiling, and no shared budget since it issues no code.
  "POST /api/auth/native/code/verify": { windowMs: 60_000, max: 10 },
  "POST /api/auth/google/start": { windowMs: 60_000, max: 20 },
  "POST /api/auth/native/google/start": { windowMs: 60_000, max: 20 },
};

/**
 * API-wide abuse guard. The exact auth rules above remain stricter; these
 * wildcard rules cover every authenticated write and the long-lived SSE
 * endpoint, including routes added after this list was written.
 */
export const API_RATE_RULES: Record<string, RateRule> = {
  ...AUTH_RATE_RULES,
  "GET /api/events*": { windowMs: 60_000, max: 30 },
  "POST /api/hooks/*": { windowMs: 60_000, max: 10 },
  // iOS registration (DEV-308): an app re-registers at launch and on token
  // change. The bucket is per IP, and a carrier NAT puts many phones behind
  // one address: the ceiling bounds a loop, not a crowd.
  "PUT /api/push/apns/devices/*": { windowMs: 60_000, max: 60 },
  // Retour OAuth d'un serveur MCP : une navigation non authentifiée, relayée
  // à l'hôte qui valide `state`. Un fournisseur renvoie une fois, pas vingt.
  "GET /api/mcp-oauth/*": { windowMs: 60_000, max: 20 },
  // Ouverture d'enrôlement : non authentifiée, donc plafonnée serrée. Un
  // opérateur en ouvre un, pas dix.
  // Chaque ouverture émet un ticket valable cinq minutes. Le plafond borne le
  // nombre de tickets vivants qu'une session peut semer en cas de fuite.
  "POST /api/runtime-enrollments/open": { windowMs: 60_000, max: 5 },
  // Montée WebSocket du lien connecteur : authentifiée par ticket ou jeton,
  // servie avant Hono (voir `modules/runtime-link/src/application/gateway.ts`,
  // qui applique cette règle par `createRateLimitGate`). Un hôte se reconnecte
  // avec backoff, jamais dix fois par minute.
  [RUNTIME_LINK_UPGRADE_RULE]: { windowMs: 60_000, max: 10 },
  // Vérification d'un export d'audit : un déchiffrement AES-GCM de 8 MiB au
  // plus et une chaîne SHA-256 à recalculer. Un opérateur en soumet un, pas
  // dix par minute.
  "POST /api/runtimes/*/creation-audit/verifications": { windowMs: 60_000, max: 10 },
  // « Vérifier le lien » peut raccrocher une connexion : borné sous les deux montages.
  "POST /api/runtime/*/link/verify": { windowMs: 60_000, max: 12 },
  "POST /api/runtimes/*/link/verify": { windowMs: 60_000, max: 12 },
  // Changement de mot de passe : plafond serré, même échelle que /login. Les
  // révocations de session sont moins sensibles (elles ferment un accès, n'en
  // donnent aucun) mais restent bornées pour éviter un bruit de fond inutile.
  "POST /api/account/security/password": { windowMs: 60_000, max: 5 },
  "POST /api/account/security/sessions/revoke-others": { windowMs: 60_000, max: 10 },
  "DELETE /api/account/security/sessions/*": { windowMs: 60_000, max: 20 },
  // État client idempotent : la SPA marque la lecture automatiquement au focus.
  "POST /api/threads/*/read": { windowMs: 60_000, max: 300 },
  "DELETE /api/threads/*/read": { windowMs: 60_000, max: 300 },
  // Garde contre les abus : un opérateur actif (lectures, messages, réactions,
  // confirmations) ne doit pas atteindre ce plafond. Les routes sensibles
  // conservent leurs règles plus strictes ci-dessus.
  "POST /api/*": { windowMs: 60_000, max: 300 },
  "PUT /api/*": { windowMs: 60_000, max: 300 },
  "PATCH /api/*": { windowMs: 60_000, max: 300 },
  "DELETE /api/*": { windowMs: 60_000, max: 300 },
};
