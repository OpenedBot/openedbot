import { Hono } from "hono";
import { readCreateGroupInput, readGroupPatch } from "@openedbot/roster/domain/groups";
import { createGroup, deleteGroup, listGroups, readGroup, updateGroup } from "@openedbot/roster/application/groups";
import type { AppVariables } from "../identity/auth";
import { requireOperator } from "../identity/auth";
import type { Db } from "@openedbot/platform-db";
import { jsonBody } from "../../interfaces/http/http-error";

export function groupRoutes(db: Db): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.get("/", async (context) => {
    const auth = context.get("auth");
    return context.json({ groups: await listGroups(db, auth.organizationId, auth.userId) });
  });
  routes.get("/:groupId", async (context) => {
    const auth = context.get("auth");
    return context.json(await readGroup(db, auth.organizationId, auth.userId, context.req.param("groupId")));
  });
  routes.post("/", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const body = await jsonBody(context.req.raw);
    const input = readCreateGroupInput(body);
    return context.json(await createGroup(db, auth.organizationId, auth.userId, input), 201);
  });
  routes.patch("/:groupId", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const body = await jsonBody(context.req.raw);
    const patch = readGroupPatch(body);
    return context.json(await updateGroup(db, auth.organizationId, auth.userId, context.req.param("groupId"), patch));
  });
  routes.delete("/:groupId", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    await deleteGroup(db, auth.organizationId, context.req.param("groupId"));
    return context.body(null, 204);
  });
  return routes;
}
