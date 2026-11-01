import { Hono } from "hono";
import type { ApiConfig } from "../../infrastructure/config";
import type { Db } from "@openedbot/platform-db";
import { withCredential, withTenant } from "@openedbot/platform-db";
import { hashCredential, randomCredential } from "../../infrastructure/crypto";
import { issueNativeAuthCode } from "@openedbot/identity/application/native-auth";
import { assertString, HttpError, jsonBody } from "../../interfaces/http/http-error";
import type { AppVariables } from "./auth";

/**
 * « Mobile Connect » : connecter un téléphone en scannant un QR affiché par la
 * console, sans retaper de mot de passe (OpenBot, Grok Bot).
 *
 * 1. `POST /api/auth/mobile-connect/tickets` (session requise) crée un ticket
 *    jetable de dix minutes et renvoie le lien à encoder en QR.
 * 2. `POST /api/auth/native/mobile-connect/redeem` (sans session) échange le
 *    ticket, une seule fois, contre un code natif lié au challenge PKCE du
 *    téléphone : la suite est celle de toute connexion native (`/native/token`).
 *
 * Le secret n'existe qu'en clair dans le lien ; la base garde son hachage.
 */
export const MOBILE_CONNECT_TICKET_TTL_MS = 10 * 60 * 1_000;

/** Schéma de l'app iOS (`CFBundleURLSchemes`), hôte `join`. */
export const MOBILE_CONNECT_SCHEME = "ohb";

const TICKET_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{32,64})$/iu;

export function mobileConnectJoinUrl(apiOrigin: string, ticket: string): string {
  const url = new URL(`${MOBILE_CONNECT_SCHEME}://join`);
  url.searchParams.set("api", apiOrigin.replace(/\/+$/u, ""));
  url.searchParams.set("ticket", ticket);
  return url.toString();
}

/** `<id>.<secret>` ; toute autre forme est refusée avant de toucher la base. */
export function parseMobileConnectTicket(raw: string): { id: string; secret: string } | null {
  const match = TICKET_PATTERN.exec(raw.trim());
  const id = match?.[1];
  const secret = match?.[2];
  if (!id || !secret) return null;
  return { id: id.toLowerCase(), secret };
}

export function mobileConnectProtectedRoutes(
  db: Db,
  config: Pick<ApiConfig, "nativeApiPublicUrl">,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post("/tickets", async (context) => {
    const auth = context.get("auth");
    if (!auth.organizationId) {
      throw new HttpError(403, "MEMBERSHIP_REQUIRED", "Choisissez d’abord une organisation.");
    }
    if (auth.impersonatedByStaffUserId) {
      throw new HttpError(403, "IMPERSONATION_READ_ONLY", "Une session d’assistance ne connecte pas d’appareil.");
    }
    const id = crypto.randomUUID();
    const secret = randomCredential(32);
    const expiresAt = new Date(Date.now() + MOBILE_CONNECT_TICKET_TTL_MS);
    await withTenant(db, auth.organizationId, async (tx) => {
      await tx`
        insert into mobile_connect_tickets (id, secret_hash, organization_id, user_id, expires_at)
        values (${id}, ${hashCredential(secret)}, ${auth.organizationId}, ${auth.userId}, ${expiresAt})
      `;
    });
    const ticket = `${id}.${secret}`;
    return context.json({
      ticketId: id,
      // The native API origin, not the console's: the app only joins the
      // deployment its build names (MobileConnectLink, foreignDeployment).
      url: mobileConnectJoinUrl(config.nativeApiPublicUrl, ticket),
      expiresAt: expiresAt.toISOString(),
    });
  });

  return routes;
}

export function mobileConnectRoutes(
  db: Db,
  config: Pick<ApiConfig, "nativeRedirectUris">,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post("/redeem", async (context) => {
    const body = await jsonBody(context.req.raw);
    const raw = assertString(body.ticket, "Le ticket", { max: 160 });
    const codeChallenge = assertString(body.codeChallenge, "Le challenge PKCE", { min: 43, max: 128 });
    const redirectUri = assertString(body.redirectUri, "L’URI de retour", { max: 1_024 });
    const clientId = assertString(body.clientId, "Le client", { max: 100 });
    if (!config.nativeRedirectUris.includes(redirectUri)) {
      throw new HttpError(400, "REDIRECT_URI_INVALID", "Cette URI de retour n’est pas autorisée.");
    }
    const ticket = parseMobileConnectTicket(raw);
    if (!ticket) {
      throw new HttpError(400, "MOBILE_CONNECT_TICKET_INVALID", "Ce code de connexion n’est pas valide.");
    }
    const secretHash = hashCredential(ticket.secret);
    const claimed = await withCredential(db, secretHash, async (tx) => {
      const rows = await tx<Array<{ organizationId: string; userId: string; consumedAt: Date | null; expiresAt: Date }>>`
        select organization_id as "organizationId", user_id as "userId",
               consumed_at as "consumedAt", expires_at as "expiresAt"
          from mobile_connect_tickets
         where id = ${ticket.id} and secret_hash = ${secretHash}
      `;
      const row = rows[0];
      if (!row) return { outcome: "invalid" as const };
      if (row.consumedAt) return { outcome: "used" as const };
      if (row.expiresAt.getTime() <= Date.now()) return { outcome: "expired" as const };
      const consumed = await tx<Array<{ id: string }>>`
        update mobile_connect_tickets set consumed_at = now()
         where id = ${ticket.id} and secret_hash = ${secretHash} and consumed_at is null and expires_at > now()
         returning id
      `;
      // Deux échanges simultanés : un seul gagne l'update, l'autre voit le ticket consommé.
      if (consumed.length === 0) return { outcome: "used" as const };
      return { outcome: "ok" as const, organizationId: row.organizationId, userId: row.userId };
    });
    switch (claimed.outcome) {
      case "invalid":
        throw new HttpError(400, "MOBILE_CONNECT_TICKET_INVALID", "Ce code de connexion n’est pas valide.");
      case "used":
        throw new HttpError(409, "MOBILE_CONNECT_TICKET_USED", "Ce code de connexion a déjà servi : affichez-en un nouveau.");
      case "expired":
        throw new HttpError(410, "MOBILE_CONNECT_TICKET_EXPIRED", "Ce code de connexion a expiré : affichez-en un nouveau.");
      case "ok":
        break;
    }
    const code = await issueNativeAuthCode(db, {
      organizationId: claimed.organizationId,
      userId: claimed.userId,
      codeChallenge,
      redirectUri,
      clientId,
    });
    return context.json({ code, redirectUri });
  });

  return routes;
}
