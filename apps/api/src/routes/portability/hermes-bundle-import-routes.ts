import { isUuid } from "@openedbot/contracts-primitives";
import { Hono } from "hono";
import { ProfileImportError } from "@openedbot/portability/domain/errors";
import { parseHermesBundleInput } from "@openedbot/portability/domain/validation";
import {
  acknowledgeImportJob, enqueueProfileImport, findIdempotentImport, listImportJobs,
  readImportJob,
} from "@openedbot/portability/sql/jobs";
import type { Db } from "@openedbot/platform-db";
import type { ApiConfig } from "../../infrastructure/config";
import { requireOperator, type AppVariables } from "../identity/auth";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";
import { readRuntimeSecret } from "@openedbot/runtimes/application/runtime-access";
import { RELAY_FEATURE_PROFILE_MANAGEMENT } from "@openedbot/contracts-connector/features";

function id(value: string): string {
  if (!isUuid(value)) throw new HttpError(404, "PROFILE_IMPORT_NOT_FOUND", "Import introuvable.");
  return value;
}

export function hermesBundleImportRoutes(db: Db, config: ApiConfig, readRuntime = readRuntimeSecret): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.onError((error, context) => {
    if (error instanceof ProfileImportError || error instanceof HttpError) {
      return context.json({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }, error.status as 400);
    }
    throw error;
  });
  routes.use("*", async (context, next) => {
    requireOperator(context.get("auth"));
    context.header("Cache-Control", "no-store");
    await next();
  });
  routes.post("/", async (context) => {
    const auth = context.get("auth");
    const { input, limitations } = parseHermesBundleInput(await jsonBody(context.req.raw, 8 * 1024 * 1024));
    const previous = await findIdempotentImport(db, auth.organizationId, input);
    if (previous) return context.json(previous, 202);
    const runtime = await readRuntime(db, config, auth.organizationId);
    if (!runtime) throw new HttpError(409, "RUNTIME_REQUIRED", "Enregistrez Hermes avant d’importer des agents.");
    if (!runtime.linkFeatures?.includes(RELAY_FEATURE_PROFILE_MANAGEMENT)) throw new HttpError(404, "PROFILE_MANAGEMENT_UNAVAILABLE", "Ce runtime n’annonce pas la gestion des profils.");
    const job = await enqueueProfileImport(db, auth.organizationId, auth.userId, runtime.id, input, limitations);
    return context.json(job, 202);
  });
  routes.get("/jobs", async (context) => {
    const cursor = context.req.query("cursor");
    return context.json(await listImportJobs(db, context.get("auth").organizationId, cursor ? id(cursor) : null));
  });
  routes.get("/jobs/:id", async (context) => context.json(await readImportJob(db, context.get("auth").organizationId, id(context.req.param("id")))));
  routes.post("/jobs/:id/acknowledge", async (context) => {
    const body = await jsonBody(context.req.raw);
    if (Object.keys(body).some((key) => key !== "verifiedOnHost") || body.verifiedOnHost !== true) {
      throw new HttpError(400, "PROFILE_IMPORT_REVIEW_REQUIRED", "Confirmez d’abord votre vérification sur l’hôte.");
    }
    const auth = context.get("auth");
    return context.json(await acknowledgeImportJob(db, auth.organizationId, auth.userId, id(context.req.param("id"))));
  });
  return routes;
}
