import { Hono } from "hono";
import type { OrganizationMemberInvitationListDto, OrganizationMemberListDto } from "@openedbot/contracts-api";
import type { AppVariables } from "./auth";
import { requireRole } from "./auth";
import type { Db } from "@openedbot/platform-db";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";
import { changeMemberRole, listMembers, removeMember } from "@openedbot/identity/application/members";
import { pauseMemberRoutines } from "@openedbot/execution/application/routines";
import {
  cancelMemberInvitation,
  listMemberInvitations,
  sendMemberInvitation,
} from "@openedbot/identity/application/member-invitations";
import type { EmailDomainResolver } from "@openedbot/identity/application/email-domain-check";
import type { ApiConfig } from "../../infrastructure/config";

export function memberRoutes(
  db: Db,
  config: Pick<ApiConfig, "webUrl">,
  deps: { checkDomain?: EmailDomainResolver } = {},
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/members", async (context) => {
    const auth = context.get("auth");
    const pending = auth.role === "owner" || auth.role === "admin"
      ? await listMemberInvitations(db, { organizationId: auth.organizationId, userId: auth.userId })
      : { invitations: [], truncated: false };
    const response: OrganizationMemberListDto = {
      members: await listMembers(db, auth.organizationId),
      pendingInvitations: pending.invitations,
      pendingInvitationsTruncated: pending.truncated,
    };
    return context.json(response);
  });

  // Inviting is free in the open core: owner or admin, into this workspace.
  routes.get("/invitations", async (context) => {
    const auth = context.get("auth");
    requireRole(auth, ["owner", "admin"]);
    const response: OrganizationMemberInvitationListDto = await listMemberInvitations(db, { organizationId: auth.organizationId, userId: auth.userId });
    return context.json(response);
  });

  routes.post("/invitations", async (context) => {
    const auth = context.get("auth");
    requireRole(auth, ["owner", "admin"]);
    const body = await jsonBody(context.req.raw);
    return context.json(await sendMemberInvitation(db, { organizationId: auth.organizationId, userId: auth.userId }, {
      email: body.email,
      role: body.role,
      locale: body.locale,
      webUrl: config.webUrl,
    }, deps.checkDomain), 201);
  });

  routes.post("/invitations/:id/resend", async (context) => {
    const auth = context.get("auth");
    requireRole(auth, ["owner", "admin"]);
    // The e-mail's language, read like the create path (`body.locale`); a
    // request without a body keeps the default (French).
    const body = context.req.raw.body ? await jsonBody(context.req.raw) : {};
    return context.json(await sendMemberInvitation(db, { organizationId: auth.organizationId, userId: auth.userId }, {
      invitationId: context.req.param("id"),
      locale: body.locale,
      webUrl: config.webUrl,
    }, deps.checkDomain));
  });

  routes.delete("/invitations/:id", async (context) => {
    const auth = context.get("auth");
    requireRole(auth, ["owner", "admin"]);
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
    await removeMember(db, { organizationId: auth.organizationId, actorUserId: auth.userId, userId }, pauseMemberRoutines);
    return context.body(null, 204);
  });

  return routes;
}

function readMembershipRole(value: unknown): "admin" | "member" {
  if (value !== "admin" && value !== "member") {
    throw new HttpError(400, "ROLE_INVALID", "Le rôle doit être admin ou member.");
  }
  return value;
}
