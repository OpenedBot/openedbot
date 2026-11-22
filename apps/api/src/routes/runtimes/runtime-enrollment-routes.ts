import { fileURLToPath } from "node:url";
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

/**
 * One command for every agent CLI of the machine where it runs: the folder it
 * runs in is the agents' working directory. The ticket goes to the prompt.
 */
export function machineConnectCommand(apiPublicUrl: string, workspaceId: string, binary = "edge-setup"): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const executable = binary === "edge-setup" ? binary : quote(binary);
  return `${executable} connect --openedbot ${quote(connectorLinkOrigin(apiPublicUrl))} --workspace-id ${workspaceId} --workspace "$PWD"`;
}

/**
 * In development, the edge-setup built from this checkout (`make
 * connect-dev-build`): an installed release may predate `connect`. Production
 * names `edge-setup`, which the console has the operator install or update first.
 */
const DEV_EDGE_SETUP = fileURLToPath(new URL("../../../../../edge-setup/dist/edge-setup", import.meta.url));

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
    if (body.machine !== undefined && typeof body.machine !== "boolean") {
      throw new HttpError(400, "RUNTIME_MACHINE_INVALID", "Le type d’appairage est invalide.");
    }
    // A machine ticket pairs every agent CLI of the machine (`edge-setup
    // connect`), each as a dedicated runtime; otherwise it links a host.
    const dedicated = body.machine === true;
    await assertSubscriptionAllowsRuntime(db, auth.organizationId, config.billingEnforced);
    // The refusal lands here, at the click, rather than at enrollment: the host would
    // already have installed and started `edge-setup link` for nothing.
    if (!dedicated) await withTenant(db, auth.organizationId, (tx) => assertNoPendingReplacement(tx, auth.organizationId));

    const secret = randomCredential(32);
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + ENROLLMENT_TTL_MS);
    await withCredential(db, hashCredential(secret), async (tx) => {
      await tx`
        insert into runtime_enrollments (
          id, secret_hash, reachability, endpoint, runtime_name, verification_code, expires_at,
          organization_id, claimed_by, claimed_at, dedicated
        ) values (
          ${id}, ${hashCredential(secret)}, ${reachability}, ${null}, ${runtimeName}, ${verificationCode()},
          ${expiresAt}, ${auth.organizationId}, ${auth.userId}, now(), ${dedicated}
        )
      `;
    });

    const ticket = `${id}.${secret}`;
    const origin = connectorLinkPublicOrigin(config, context.req.header("origin"));
    return context.json({
      enrollmentId: id,
      reachability,
      endpoint: null,
      runtimeName,
      ...(dedicated ? { workspaceId: auth.organizationId } : {}),
      ticket,
      command: dedicated
        ? machineConnectCommand(origin, auth.organizationId, config.environment === "development" ? DEV_EDGE_SETUP : "edge-setup")
        : connectorLinkCommand(origin),
      expiresAt: expiresAt.toISOString(),
    }, 201);
  });

  routes.get("/:enrollmentId/status", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const enrollmentId = assertString(context.req.param("enrollmentId"), "L’identifiant d’enrôlement", { max: 64 });
    const row = await withTenant(db, auth.organizationId, async (tx) => {
      const rows = await tx<Array<Pick<EnrollmentRow, "id" | "reachability" | "claimedAt" | "consumedAt" | "runtimeId" | "expiresAt" | "claimedEngines">>>`
        select id, reachability, claimed_at as "claimedAt", consumed_at as "consumedAt",
               runtime_id as "runtimeId", expires_at as "expiresAt", claimed_engines as "claimedEngines"
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
      engines: row.claimedEngines,
      expiresAt: row.expiresAt.toISOString(),
    });
  });

  return routes;
}
