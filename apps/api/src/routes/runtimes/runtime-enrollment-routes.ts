import { Hono } from "hono";
import type { ApiConfig } from "../../infrastructure/config";
import { withCredential, withTenant } from "@openedbot/platform-db";
import { hashCredential, randomCredential } from "../../infrastructure/crypto";
import type { AppVariables } from "../identity/auth";
import { requireOperator } from "../identity/auth";
import { assertString, HttpError, jsonBody } from "../../interfaces/http/http-error";
import { assertSubscriptionAllowsRuntime } from "./runtime-subscription";
import { assertNoPendingReplacement } from "./runtime-replacement";
import { enrollmentState, type EnrollmentRow } from "@openedbot/runtimes/application/runtime-enrollment";
import type { Db } from "@openedbot/platform-db";

export { enrollmentState, readEnrollmentRow, type EnrollmentRow, type EnrollmentState } from "@openedbot/runtimes/application/runtime-enrollment";

export const ENROLLMENT_TTL_MS = 5 * 60_000;

const VERIFICATION_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const VERIFICATION_CODE_LENGTH = 6;

export function readEnrollmentReachability(value: unknown): "connector" {
  if (value === undefined || value === null || value === "connector") return "connector";
  throw new HttpError(400, "RUNTIME_CONNECTOR_REQUIRED", "Seule la connexion sortante sécurisée est acceptée.");
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * The ticket is entered at the hidden prompt and never placed in argv.
 *
 * A development origin reached through an SSH reverse tunnel is plain HTTP on
 * the host's own loopback: `edge-setup` only accepts it behind
 * `--insecure-openedbot`, so the command shown here carries the flag rather than
 * leaving the operator with a copy-paste that is refused. Production origins
 * are HTTPS and never get it.
 */
export function connectorLinkCommand(apiPublicUrl: string): string {
  const origin = connectorLinkOrigin(apiPublicUrl);
  return `edge-setup link --openedbot ${origin} --yes${isLoopbackHttpOrigin(origin) ? " --insecure-openedbot" : ""}`;
}

function connectorLinkOrigin(apiPublicUrl: string): string {
  const origin = apiPublicUrl.replace(/\/+$/, "");
  try {
    const parsed = new URL(origin);
    if (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname)) {
      // The reverse tunnel binds its VPS endpoint on IPv4. Avoid localhost
      // resolving to [::1] on hosts where the SSH listener is IPv4-only.
      parsed.hostname = "127.0.0.1";
      return parsed.origin;
    }
  } catch {
    // Keep the existing value so the command remains subject to validation.
  }
  return origin;
}

function isLoopbackHttpOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * The origin the enrollment command names: the dedicated link origin when
 * RUNTIME_LINK_PUBLIC_URL sets one, otherwise the API origin rules below.
 * Kept apart from connectorOpenedbotOrigin, which also builds browser callbacks
 * (MCP OAuth) that must stay on the API origin.
 */
export function connectorLinkPublicOrigin(
  config: Pick<ApiConfig, "environment" | "publicUrl"> & Partial<Pick<ApiConfig, "linkPublicUrl">>,
  requestOrigin: string | undefined,
): string {
  const link = config.linkPublicUrl?.replace(/\/+$/, "");
  if (link && link !== config.publicUrl.replace(/\/+$/, "")) return link;
  return connectorOpenedbotOrigin(config, requestOrigin);
}

/**
 * A development request made through an HTTPS tunnel must send the connector
 * back through that tunnel. Production only trusts its deployment-owned URL.
 */
export function connectorOpenedbotOrigin(
  config: Pick<ApiConfig, "environment" | "publicUrl">,
  requestOrigin: string | undefined,
): string {
  if (config.environment !== "development" || !requestOrigin) return config.publicUrl;
  try {
    const parsed = new URL(requestOrigin);
    if (parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" && parsed.origin === requestOrigin) {
      return parsed.origin;
    }
  } catch {
    // Fall back to deployment configuration. Untrusted text never becomes a
    // free-form part of a command shown to the operator.
  }
  return config.publicUrl;
}

function verificationCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(VERIFICATION_CODE_LENGTH));
  return Array.from(bytes, (byte) => VERIFICATION_CODE_ALPHABET[byte % VERIFICATION_CODE_ALPHABET.length]).join("");
}

/** Authenticated, connector-only enrollment routes. */
export function runtimeEnrollmentClaimRoutes(db: Db, config: ApiConfig): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post("/open", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const body = await jsonBody(context.req.raw);
    const runtimeName = assertString(body.name, "Le nom du runtime", { max: 100 });
    const reachability = readEnrollmentReachability(body.reachability);
    await assertSubscriptionAllowsRuntime(db, auth.organizationId, config.billingEnforced);
    // The refusal lands here, at the click, rather than at enrollment: the host would
    // already have installed and started `edge-setup link` for nothing.
    await withTenant(db, auth.organizationId, (tx) => assertNoPendingReplacement(tx, auth.organizationId));

    const secret = randomCredential(32);
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + ENROLLMENT_TTL_MS);
    await withCredential(db, hashCredential(secret), async (tx) => {
      await tx`
        insert into runtime_enrollments (
          id, secret_hash, reachability, endpoint, runtime_name, verification_code, expires_at,
          organization_id, claimed_by, claimed_at
        ) values (
          ${id}, ${hashCredential(secret)}, ${reachability}, ${null}, ${runtimeName}, ${verificationCode()},
          ${expiresAt}, ${auth.organizationId}, ${auth.userId}, now()
        )
      `;
    });

    const ticket = `${id}.${secret}`;
    return context.json({
      enrollmentId: id,
      reachability,
      endpoint: null,
      runtimeName,
      ticket,
      command: connectorLinkCommand(connectorLinkPublicOrigin(config, context.req.header("origin"))),
      expiresAt: expiresAt.toISOString(),
    }, 201);
  });

  routes.get("/:enrollmentId/status", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const enrollmentId = assertString(context.req.param("enrollmentId"), "L’identifiant d’enrôlement", { max: 64 });
    const row = await withTenant(db, auth.organizationId, async (tx) => {
      const rows = await tx<Array<Pick<EnrollmentRow, "id" | "reachability" | "claimedAt" | "consumedAt" | "runtimeId" | "expiresAt">>>`
        select id, reachability, claimed_at as "claimedAt", consumed_at as "consumedAt",
               runtime_id as "runtimeId", expires_at as "expiresAt"
          from runtime_enrollments
         where id = ${enrollmentId} and organization_id = ${auth.organizationId}
         limit 1
      `;
      return rows[0] ?? null;
    });
    if (!row) throw new HttpError(404, "ENROLLMENT_NOT_FOUND", "Cet enrôlement n’existe pas.");
    if (row.reachability !== "connector") {
      throw new HttpError(410, "RUNTIME_CONNECTOR_REQUIRED", "Cet ancien enrôlement direct n’est plus utilisable.");
    }
    return context.json({
      enrollmentId: row.id,
      reachability: "connector" as const,
      state: enrollmentState(row),
      runtimeId: row.runtimeId,
      expiresAt: row.expiresAt.toISOString(),
    });
  });

  return routes;
}
