import { Hono } from "hono";
import type { OrganizationMemberListDto } from "@openedbot/contracts-api";
import type { AppVariables } from "./auth";
import { requireRole } from "./auth";
import type { Db } from "@openedbot/platform-db";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";
import { changeMemberRole, listMembers, removeMember } from "@openedbot/identity/application/members";
import {
  cancelMemberInvitation,
  listMemberInvitations,
  sendMemberInvitation,
} from "@openedbot/identity/application/member-invitations";
import { listClientFleetGrants, revokeFleetGrant } from "@openedbot/identity/application/workspaces";
import type { ApiConfig } from "../../infrastructure/config";
import type { EmailDomainResolver } from "@openedbot/identity/application/email-domain-check";

export function memberRoutes(db: Db, config?: Pick<ApiConfig, "webUrl">, deps: { checkDomain?: EmailDomainResolver } = {}): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/members", async (context) => {
    const auth = context.get("auth");
    const response: OrganizationMemberListDto = {
      members: await listMembers(db, auth.organizationId),
      pendingInvitations: auth.role === "owner" || auth.role === "admin"
        ? await listMemberInvitations(db, { organizationId: auth.organizationId, userId: auth.userId })
        : [],
    };
    return context.json(response);
  });

  routes.get("/invitations", async (context) => {
    const auth = context.get("auth");
    return context.json({ invitations: await listMemberInvitations(db, { organizationId: auth.organizationId, userId: auth.userId }) });
  });

  routes.post("/invitations", async (context) => {
    if (!config) throw new HttpError(503, "MEMBER_INVITATION_UNAVAILABLE", "Invitations indisponibles.");
    const auth = context.get("auth");
    const body = await jsonBody(context.req.raw);
    return context.json(await sendMemberInvitation(db, { organizationId: auth.organizationId, userId: auth.userId }, {
      email: body.email,
      role: body.role,
      locale: body.locale,
      webUrl: config.webUrl,
    }, deps.checkDomain), 201);
  });

  routes.post("/invitations/:id/resend", async (context) => {
    if (!config) throw new HttpError(503, "MEMBER_INVITATION_UNAVAILABLE", "Invitations indisponibles.");
    const auth = context.get("auth");
    return context.json(await sendMemberInvitation(db, { organizationId: auth.organizationId, userId: auth.userId }, {
      invitationId: context.req.param("id"),
      webUrl: config.webUrl,
    }, deps.checkDomain));
  });

  routes.delete("/invitations/:id", async (context) => {
    const auth = context.get("auth");
    await cancelMemberInvitation(db, { organizationId: auth.organizationId, userId: auth.userId }, context.req.param("id"));
    return context.body(null, 204);
  });

  routes.patch("/members/:userId", async (context) => {
    const auth = context.get("auth");
    requireRole(auth, ["owner", "admin"]);
    const body = await jsonBody(context.req.raw);
    const role = readMembershipRole(body.role);
    const userId = context.req.param("userId");
    await changeMemberRole(db, { organizationId: auth.organizationId, actorUserId: auth.userId, userId, role });
    return context.json({ userId, role });
  });

  routes.delete("/members/:userId", async (context) => {
    const auth = context.get("auth");
    requireRole(auth, ["owner", "admin"]);
    const userId = context.req.param("userId");
    await removeMember(db, { organizationId: auth.organizationId, actorUserId: auth.userId, userId });
    return context.body(null, 204);
  });

  /** The agencies this client organization lets in. */
  routes.get("/fleet-grants", async (context) => {
    const auth = context.get("auth");
    requireRole(auth, ["owner", "admin"]);
    return context.json({ grants: await listClientFleetGrants(db, auth.organizationId) });
  });

  /** The client owner withdraws an agency; every member of that agency loses access at once. */
  routes.delete("/fleet-grants/:grantId", async (context) => {
    const auth = context.get("auth");
    requireRole(auth, ["owner"]);
    await revokeFleetGrant(db, {
      actorUserId: auth.userId,
      actingOrganizationId: auth.organizationId,
      side: "client",
      target: context.req.param("grantId"),
    });
    return context.body(null, 204);
  });

  return routes;
}

/** `agency` is never a membership role since 0086: an agency is let in through a grant. */
function readMembershipRole(value: unknown): "admin" | "member" {
  if (value !== "admin" && value !== "member") {
    throw new HttpError(400, "ROLE_INVALID", "Le rôle doit être admin ou member.");
  }
  return value;
}
