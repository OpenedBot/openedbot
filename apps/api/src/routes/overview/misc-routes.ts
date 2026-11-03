import { readBusinessMetrics, readOverviewActivity, readUsageSeries } from "@openedbot/runtimes/application/business-metrics";
import { isStrictUuid, isoInstant } from "@openedbot/contracts-primitives";
import { decisionTrace, type DecisionTraceRow } from "@openedbot/conversation/domain/decision-trace";
import { EMPTY_WORKSPACE_ID } from "@openedbot/identity/domain/workspace-access";
import {
  clearOrganizationOnboarding,
  completeOrganizationOnboarding,
  markOrganizationOnboardingReset,
  markUserOnboardingCompleted,
  mergeOrganizationOnboarding,
  resetUserOnboarding,
  upsertOperatorProfile,
} from "@openedbot/identity/sql/onboarding";
import { Hono } from "hono";
import { SQL } from "bun";
import type { DecisionDto, OnboardingResetScope, UsagePoint } from "@openedbot/contracts-api";
import { ONBOARDING_RESET_SCOPES } from "@openedbot/contracts-api";
import { assertDevResetAllowed, performDevDataReset } from "../../application/dev-reset";
import type { AppVariables } from "../identity/auth";
import { requireOperator } from "../identity/auth";
import type { ApiConfig } from "../../infrastructure/config";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { assertString, HttpError, jsonBody } from "../../interfaces/http/http-error";


export type DecisionListFilters = {
  botId?: string;
  choice?: "once" | "deny";
  origin?: "human" | "policy";
};

export type MiscRoutesOptions = Pick<ApiConfig, "environment"> & {
  /** DSN privilégiée du vidage `scope: "full"`. Voir `ApiConfig`. */
  devResetDatabaseUrl?: string | null;
  /** Point d'injection de test : ouvre la connexion privilégiée du vidage. */
  openDevResetDb?: (url: string) => SQL;
};

export function miscRoutes(db: Db, options: MiscRoutesOptions): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/overview", async (context) => {
    const auth = context.get("auth");
    const overview = await withTenant(db, auth.organizationId, async (tx) => {
      const metrics = await readBusinessMetrics(tx, auth.organizationId);
      const activity = await readOverviewActivity(tx, auth.organizationId);
      return {
        bots: metrics.activeBots, runsTotal: metrics.runsTotal, runsRunning: metrics.runsRunning,
        awaitingApproval: metrics.pendingApprovals, completed: metrics.completed, failed: metrics.failed,
        tokens: metrics.tokens, successRate: metrics.successRate, activity,
      };
    });
    return context.json(overview);
  });

  // Les quatre granularités d'un coup (~171 points) : la bascule côté client
  // est instantanée et la route n'a aucun paramètre à valider. L'overview garde
  // son refetch court pour les runs en cours ; l'usage n'en a pas besoin.
  routes.get("/usage", async (context) => {
    const auth = context.get("auth");
    const usage = await withTenant(db, auth.organizationId, async (tx) => ({
      day: await usageSeries(tx, auth.organizationId, "day", 90),
      week: await usageSeries(tx, auth.organizationId, "week", 52),
      month: await usageSeries(tx, auth.organizationId, "month", 24),
      year: await usageSeries(tx, auth.organizationId, "year", 5),
    }));
    return context.json(usage);
  });

  routes.get("/usage/models", async (context) => {
    const auth = context.get("auth");
    // Sans `days`, la fenêtre historique de 90 jours : les appelants existants
    // ne changent pas. La carte des quotas lit 1 et 30 jours.
    const rawDays = context.req.query("days");
    const days = rawDays === undefined ? USAGE_MODELS_WINDOW_DAYS : usageWindowDays(rawDays);
    const usage = await withTenant(db, auth.organizationId, (tx) => usageByModel(tx, auth.organizationId, days));
    return context.json(usage);
  });

  /**
   * Consommation openedbot par bot. Les limites fournisseur sont réservées aux mêmes
   * rôles, et cette ventilation peut révéler l'activité d'un bot : ne pas la
   * laisser devenir une voie indirecte de lecture pour un membre.
   */
  routes.get("/usage/bots", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const days = usageWindowDays(context.req.query("days") ?? "7");
    const usage = await withTenant(db, auth.organizationId, (tx) => usageByBot(tx, auth.organizationId, days));
    return context.json(usage);
  });

  routes.get("/operator", async (context) => {
    const auth = context.get("auth");
    const operator = await withTenant(db, auth.organizationId, (tx) =>
      readOperatorProfile(tx, auth.organizationId),
    );
    return context.json({ operator });
  });

  routes.put("/operator", async (context) => {
    const auth = context.get("auth");
    const body = await jsonBody(context.req.raw);
    const username = assertString(body.username, "Le nom d’utilisateur", { min: 2, max: 32 }).toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(username) || username === "user") {
      throw new HttpError(400, "USERNAME_INVALID", "Ce nom d’utilisateur est invalide ou réservé.");
    }
    const profile = await withTenant(db, auth.organizationId, (tx) => upsertOperatorProfile(tx, auth.organizationId, username));
    return context.json({ operator: { ...profile, updatedAt: isoInstant(profile.updatedAt) } });
  });

  routes.get("/onboarding", async (context) => {
    const auth = context.get("auth");
    const result = await readOnboardingState(db, auth.organizationId, auth.userId);
    return context.json(result);
  });

  routes.patch("/onboarding", async (context) => {
    const auth = context.get("auth");
    assertOrganizationDefined(auth.organizationId);
    const body = await jsonBody(context.req.raw);
    // Le corps est fusionné tel quel dans le jsonb `onboarding`: borne l'abus de stockage.
    if (JSON.stringify(body).length > 8_192) {
      throw new HttpError(413, "ONBOARDING_TOO_LARGE", "L’état d’onboarding est trop volumineux.");
    }
    // Le nom d'espace EST le nom de l'organisation. Le laisser dormir dans le
    // jsonb rendait la saisie de l'accueil invisible partout ailleurs (export
    // d'équipe, backoffice staff, facturation), et seul l'écran qui l'avait
    // demandée la relisait. Même borne qu'au signup (`@openedbot/identity/domain/signup`).
    // Le jsonb garde sa copie : `readOnboardingState` la préfère, et les deux
    // valeurs sont désormais écrites par la même instruction.
    const workspaceName = body.workspaceName === undefined
      ? null
      : assertString(body.workspaceName, "Le nom de l’espace", { max: 80 });
    if (workspaceName !== null) body.workspaceName = workspaceName;
    await withTenant(db, auth.organizationId, (tx) =>
      mergeOrganizationOnboarding(tx, auth.organizationId, body, workspaceName));
    return context.json(await readOnboardingState(db, auth.organizationId, auth.userId));
  });

  // La sortie de l'accueil est un fait sur la PERSONNE (`users.onboarding_completed`,
  // 0025) ; l'espace garde sa date et son chemin de sortie, idempotents.
  routes.post("/onboarding/complete", async (context) => {
    const auth = context.get("auth");
    assertOrganizationDefined(auth.organizationId);
    const body = await jsonBody(context.req.raw);
    const completionPath = assertString(body.path, "Le chemin d’onboarding", { max: 64 });
    await withTenant(db, auth.organizationId, async (tx) => {
      await completeOrganizationOnboarding(tx, auth.organizationId, completionPath);
      await markUserOnboardingCompleted(tx, auth.userId);
    });
    return context.json(await readOnboardingState(db, auth.organizationId, auth.userId));
  });

  // Outil de développement, et rien d'autre : la route n'est pas MONTÉE hors
  // `development`, elle répond donc 404 en test comme en production. Elle
  // rejoue l'accueil pour de vrai : le flag de la personne retombe, et
  // l'espace courant oublie sa date de sortie et ses réponses, pour que
  // chaque étape se rejoue au lieu d'être sautée comme déjà faite.
  if (options.environment === "development") {
    routes.post("/onboarding/reset", async (context) => {
      const auth = context.get("auth");
      const scope = await readResetScope(context.req.raw);
      if (scope === "full") {
        await runFullDevReset(options);
        await withTenant(db, auth.organizationId, (tx) => markOrganizationOnboardingReset(tx, auth.organizationId));
      } else {
        await withTenant(db, auth.organizationId, async (tx) => {
          await resetUserOnboarding(tx, auth.userId);
          await clearOrganizationOnboarding(tx, auth.organizationId);
        });
      }
      return context.json(await readOnboardingState(db, auth.organizationId, auth.userId));
    });
  }

  routes.get("/decisions", async (context) => {
    const auth = context.get("auth");
    const filters = readDecisionFilters({
      botId: context.req.query("botId"),
      choice: context.req.query("choice"),
      origin: context.req.query("origin"),
    });
    const decisions = await withTenant(db, auth.organizationId, (tx) => listDecisions(tx, auth.organizationId, filters));
    return context.json({ decisions });
  });

  routes.get("/decisions/export", async (context) => {
    const auth = context.get("auth");
    const filters = readDecisionFilters({
      botId: context.req.query("botId"),
      choice: context.req.query("choice"),
      origin: context.req.query("origin"),
    });
    const decisions = await withTenant(db, auth.organizationId, (tx) =>
      listDecisionExports(tx, auth.organizationId, filters),
    );
    const body = decisions.map((decision) => JSON.stringify(decision)).join("\n");
    context.header("Content-Type", "application/x-ndjson; charset=utf-8");
    context.header("Content-Disposition", 'attachment; filename="decisions.jsonl"');
    return context.body(body === "" ? "" : `${body}\n`);
  });

  return routes;
}

/**
 * Série d'usage de jetons zero-fill : `buckets` buckets calendaires `unit`, le
 * dernier étant le bucket courant. Le bucket temporel est
 * `coalesce(ended_at, created_at)`, comme la série d'activité de `/overview`,
 * et le prédicat de plage sur cette expression active l'index
 * `runs_org_effective_time_idx`. `unit` est une union TS
 * fermée, jamais une entrée utilisateur : le `('1 ' || unit)::interval` est sûr.
 */
export async function usageSeries(
  tx: Bun.TransactionSQL,
  organizationId: string,
  unit: "day" | "week" | "month" | "year",
  buckets: number,
): Promise<UsagePoint[]> {
  return readUsageSeries(tx, organizationId, unit, buckets);
}

export { USAGE_MODELS_WINDOW_DAYS, usageByBot, usageByModel, usageWindowDays } from "./usage-queries";
import { USAGE_MODELS_WINDOW_DAYS, usageByBot, usageByModel, usageWindowDays } from "./usage-queries";

/** `OperatorProfileDto` de l'organisation, `null` tant qu'aucun handle n'est choisi. */
export async function readOperatorProfile(
  tx: Bun.TransactionSQL,
  organizationId: string,
): Promise<{ username: string; updatedAt: string } | null> {
  const rows = await tx<Array<{ username: string; updatedAt: Date | string }>>`
    select username, updated_at as "updatedAt" from operator_profiles
     where organization_id = ${organizationId}
  `;
  const row = rows[0];
  return row ? { ...row, updatedAt: isoInstant(row.updatedAt) } : null;
}

/**
 * `OnboardingStateDto` : l'état de l'espace (réponses, nom, date de sortie,
 * chemin) et le flag de la PERSONNE (`completed`), qui seul décide du gate.
 * `users` n'est pas sous RLS : la jointure sur l'identifiant de session
 * passe sous `withTenant` sans porte supplémentaire.
 */
async function readOnboardingState(db: Db, organizationId: string, userId: string) {
  return withTenant(db, organizationId, async (tx) => {
    const rows = await tx<Array<{
      onboarding: Record<string, unknown> | null;
      name: string;
      onboardedAt: Date | string | null;
      completed: boolean | null;
    }>>`
      select o.onboarding, o.name, o.onboarded_at as "onboardedAt",
             u.onboarding_completed as completed
        from organizations o
        left join users u on u.id = ${userId}
       where o.id = ${organizationId}
    `;
    const row = rows[0];
    // Aucune organisation encore (0086) : l'accueil ouvre l'étape Organisation.
    if (!row) {
      const users = await tx<Array<{ completed: boolean | null }>>`
        select onboarding_completed as completed from users where id = ${userId}
      `;
      return {
        questionnaire: null,
        workspaceName: null,
        onboardedAt: null,
        completionPath: null,
        completed: users[0]?.completed === true,
        needsOrganization: true,
      };
    }
    return {
      questionnaire: row.onboarding?.questionnaire ?? null,
      workspaceName: row.onboarding?.workspaceName ?? row.name,
      onboardedAt: row.onboardedAt ? isoInstant(row.onboardedAt) : null,
      completionPath: row.onboarding?.completionPath ?? null,
      completed: row.completed === true,
      organizationReset: row.onboarding?.organizationReset === true,
    };
  });
}

/**
 * Corps OPTIONNEL : `POST /onboarding/reset` sans corps, ou avec un corps
 * vide, garde le comportement historique (`flag`). `jsonBody` refuserait un
 * corps absent, on lit donc le texte brut avant de décider.
 */
async function readResetScope(request: Request): Promise<OnboardingResetScope> {
  let raw: string;
  try {
    raw = (await request.text()).trim();
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Le corps JSON est invalide.");
  }
  if (raw === "") return "flag";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Le corps JSON est invalide.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "INVALID_JSON", "Le corps JSON est invalide.");
  }
  const scope = (parsed as { scope?: unknown }).scope;
  if (scope === undefined || scope === null) return "flag";
  if (typeof scope !== "string" || !ONBOARDING_RESET_SCOPES.includes(scope as OnboardingResetScope)) {
    throw new HttpError(400, "INVALID_RESET_SCOPE", "La portée de réinitialisation est invalide.");
  }
  return scope as OnboardingResetScope;
}

/**
 * Le vidage complet ne passe PAS par `db` : `ohb_api` n'a ni `delete` sur les
 * tables append-only (`decisions`, `team_imports`, `email_outbox`,
 * `tenant_blob_deletions`) ni le droit de `truncate` une table qu'il ne
 * possède pas. Il lui faut la DSN propriétaire `DEV_RESET_DATABASE_URL` ;
 * sans elle, le chemin terminal `make db-reset-keep-users` reste disponible et
 * la route le dit au lieu d'échouer à moitié.
 */
async function runFullDevReset(options: MiscRoutesOptions): Promise<void> {
  const url = options.devResetDatabaseUrl?.trim();
  if (!url) {
    throw new HttpError(
      503,
      "DEV_RESET_UNAVAILABLE",
      "Le vidage complet exige DEV_RESET_DATABASE_URL (DSN propriétaire de la base locale) ; sinon lancez `make db-reset-keep-users CONFIRM=yes`.",
    );
  }
  try {
    assertDevResetAllowed({ environment: options.environment, databaseUrl: url });
  } catch (error) {
    throw new HttpError(403, "DEV_RESET_REFUSED", error instanceof Error ? error.message : "Vidage refusé.");
  }
  const open = options.openDevResetDb ?? ((dsn: string) => new SQL({ url: dsn, max: 1 }));
  const sql = open(url);
  try {
    await performDevDataReset(sql);
  } finally {
    await sql.close?.();
  }
}

export function readDecisionFilters(query: { botId?: string; choice?: string; origin?: string }): DecisionListFilters {
  const choice = query.choice === "once" || query.choice === "deny" ? query.choice : undefined;
  const origin = query.origin === "human" || query.origin === "policy" ? query.origin : undefined;
  const botId = query.botId && isStrictUuid(query.botId) ? query.botId.toLowerCase() : undefined;
  return { botId, choice, origin };
}

type DecisionListRow = {
  id: string;
  runId: string | null;
  botId: string | null;
  botName: string | null;
  action: string | null;
  kind: string | null;
  choice: string;
  approverUserId: string | null;
  approverRole: string | null;
  origin: "human" | "policy";
  policy: string | null;
  previousHash: string | null;
  entryHash: string | null;
  chainSequence: string | number | null;
  issuedAt: Date | string;
} & DecisionTraceRow;

const DECISION_POLICIES = ["auto", "bypass", "manual", "plan"] as const;

function decisionPolicy(value: string | null): DecisionDto["policy"] {
  return (DECISION_POLICIES as readonly string[]).includes(value ?? "") ? value as DecisionDto["policy"] : null;
}

function asText(value: string | null | undefined): string {
  return value ?? "";
}

export function toDecisionDto(row: DecisionListRow): DecisionDto {
  return {
    id: row.id,
    runId: asText(row.runId),
    botId: asText(row.botId),
    botName: asText(row.botName),
    action: asText(row.action),
    kind: asText(row.kind) || "shell",
    choice: row.choice === "deny" ? "deny" : "once",
    origin: row.origin,
    policy: decisionPolicy(row.policy),
    approverUserId: row.approverUserId,
    approverRole: asText(row.approverRole),
    entryHash: row.entryHash,
    issuedAt: isoInstant(row.issuedAt),
    trace: decisionTrace(row),
  };
}

function toDecisionExportDto(row: DecisionListRow): Record<string, unknown> {
  const decision = toDecisionDto(row);
  if (row.origin === "policy") return decision;
  return {
    ...decision,
    previousHash: row.previousHash,
    chainSequence: row.chainSequence === null ? null : Number(row.chainSequence),
  };
}

/**
 * Journal des gates résolues, projeté sur le DTO que le client affiche
 * (bot, action, type). Les pointeurs live (run/thread/approval/bot) sont
 * optionnels : après suppression du bot ils sont nuls, et l'enveloppe
 * hash-chaînée reste la source historique pour les décisions humaines.
 */
export async function listDecisions(
  tx: Bun.TransactionSQL,
  organizationId: string,
  filters: DecisionListFilters = {},
): Promise<DecisionDto[]> {
  const rows = await readDecisionRows(tx, organizationId, filters);
  return rows.map(toDecisionDto);
}

export async function listDecisionExports(
  tx: Bun.TransactionSQL,
  organizationId: string,
  filters: DecisionListFilters = {},
): Promise<Record<string, unknown>[]> {
  const rows = await readDecisionRows(tx, organizationId, filters);
  return rows.map(toDecisionExportDto);
}

async function readDecisionRows(
  tx: Bun.TransactionSQL,
  organizationId: string,
  filters: DecisionListFilters,
): Promise<DecisionListRow[]> {
  const choice = filters.choice ?? "";
  const botId = filters.botId ?? "";
  const origin = filters.origin ?? "";
  const rows = await tx<DecisionListRow[]>`
    with entries as (
      select d.id,
             coalesce(d.run_id::text, d.envelope->>'runId', '') as "runId",
             coalesce(r.bot_id::text, t.bot_id::text, d.envelope->>'botId', '') as "botId",
             coalesce(nullif(b.name, ''), nullif(d.envelope->>'botName', ''), '') as "botName",
             coalesce(nullif(a.command, ''), nullif(d.envelope->>'action', ''), '') as action,
             coalesce(nullif(d.envelope->>'kind', ''), 'shell') as kind,
             d.choice,
             coalesce(d.actor_user_id::text, d.envelope->>'actorUserId') as "approverUserId",
             coalesce(m.role, '') as "approverRole",
             'human'::text as origin,
             null::text as policy,
             d.previous_hash as "previousHash",
             d.entry_hash as "entryHash",
             d.chain_sequence as "chainSequence",
             d.created_at as "issuedAt",
             -- PERM2-11: why the gate reached this person, and who they are.
             -- Named keys of decision_detail only, never the object.
             a.decision_stage as "traceStage",
             a.decided_by_kind as "decidedByKind",
             coalesce(nullif(du.display_name, ''), du.email) as "deciderName",
             a.decision_detail->>'reason' as "traceReason",
             a.decision_detail->>'heldStage' as "heldStage",
             a.decision_detail->>'heldReason' as "heldReason",
             a.decision_detail->>'always' as always,
             coalesce(a.decision_detail ? 'grantId' or a.decision_detail ? 'runtimeSettingId', false) as "alwaysRecorded",
             a.decision_detail->>'grantError' as "grantError",
             a.decision_detail->>'humanOverridden' as "humanOverridden",
             false as "policyChanged",
             null::text as "grantKind",
             null::text as "grantAuthorName",
             null::text as "grantAuthorKind",
             null::boolean as "grantFromAlways",
             null::timestamptz as "grantCreatedAt",
             null::boolean as "grantRevoked"
        from decisions d
        left join runs r
          on r.organization_id = d.organization_id and r.id = d.run_id
        left join threads t
          on t.organization_id = d.organization_id and t.id = d.thread_id
        left join bots b
          on b.organization_id = d.organization_id
         and (
           b.id = r.bot_id
           or (r.bot_id is null and b.id = t.bot_id)
           or (r.bot_id is null and t.bot_id is null and b.id::text = d.envelope->>'botId')
         )
        left join approval_requests a
          on a.organization_id = d.organization_id and a.id = d.approval_request_id
        left join memberships m
          on m.organization_id = d.organization_id and m.user_id = d.actor_user_id
        left join users du on du.id = d.actor_user_id
       where d.organization_id = ${organizationId}
      union all
      select a.id,
             a.run_id::text as "runId",
             coalesce(r.bot_id::text, t.bot_id::text, '') as "botId",
             coalesce(nullif(b.name, ''), '') as "botName",
             coalesce(nullif(a.command, ''), '') as action,
             coalesce(nullif(a.tool_key, ''), 'shell')::text as kind,
             coalesce(a.selected_choice, 'once') as choice,
             null::text as "approverUserId",
             ''::text as "approverRole",
             'policy'::text as origin,
             a.resolved_by_policy as policy,
             null::text as "previousHash",
             null::text as "entryHash",
             null::bigint as "chainSequence",
             a.resolved_at as "issuedAt",
             a.decision_stage as "traceStage",
             a.decided_by_kind as "decidedByKind",
             null::text as "deciderName",
             a.decision_detail->>'reason' as "traceReason",
             a.decision_detail->>'heldStage' as "heldStage",
             a.decision_detail->>'heldReason' as "heldReason",
             null::text as always,
             false as "alwaysRecorded",
             null::text as "grantError",
             null::text as "humanOverridden",
             coalesce(a.decision_detail->'policyChanged' = 'true'::jsonb, false) as "policyChanged",
             case when gt.id is not null then 'bot_tool'
                  when a.decision_stage = 'grant' and a.decision_detail->>'reason' = 'terminal_switch' then 'runtime_terminal'
             end as "grantKind",
             coalesce(gt."authorName", st."authorName") as "grantAuthorName",
             coalesce(gt."authorKind", st."authorKind") as "grantAuthorKind",
             coalesce(gt."fromAlways", st."fromAlways", false) as "grantFromAlways",
             coalesce(gt."createdAt", st."updatedAt") as "grantCreatedAt",
             case when gt.id is not null then gt.revoked
                  when a.decision_stage = 'grant' and a.decision_detail->>'reason' = 'terminal_switch'
                    then not exists (
                      select 1 from runtime_permission_settings now_on
                       where now_on.organization_id = a.organization_id and now_on.terminal_danger_always
                    )
             end as "grantRevoked"
        from approval_requests a
        left join runs r
          on r.organization_id = a.organization_id and r.id = a.run_id
        left join threads t
          on t.organization_id = a.organization_id and t.id = a.thread_id
        left join bots b
          on b.organization_id = a.organization_id and b.id = coalesce(r.bot_id, t.bot_id)
        -- PERM2-11: the grant that answered the gate. The worker records its
        -- id; an older row falls back to the grant of this tool on this bot
        -- that was active when the gate was answered (one at most, 0140).
        left join lateral (
          select g.id, g.created_by_kind as "authorKind",
                 coalesce(nullif(gu.display_name, ''), gu.email) as "authorName",
                 g.created_from_approval_id is not null as "fromAlways",
                 g.created_at as "createdAt", g.status = 'revoked' as revoked
            from bot_permission_grants g
            left join users gu on gu.id = g.created_by_user_id
           where a.decision_stage = 'grant' and a.decision_detail->>'reason' = 'grant'
             and g.organization_id = a.organization_id
             and g.bot_id = coalesce(r.bot_id, t.bot_id) and g.tool_key = a.tool_key
             and case when a.decision_detail ? 'grantId' then g.id::text = a.decision_detail->>'grantId'
                      else g.created_at <= a.resolved_at and (g.revoked_at is null or g.revoked_at > a.resolved_at) end
           order by g.created_at desc
           limit 1
        ) gt on true
        -- The runtime switch keeps no history: its author is told only while
        -- its last write is older than the answer it gave.
        left join lateral (
          select s.updated_by_kind as "authorKind",
                 coalesce(nullif(su.display_name, ''), su.email) as "authorName",
                 s.updated_at as "updatedAt",
                 -- A « Toujours » turns the switch on in the transaction that
                 -- answers its gate: both carry the same now().
                 exists (
                   select 1 from approval_requests origin
                    where origin.organization_id = s.organization_id
                      and origin.decision_detail->>'always' = 'always_runtime_terminal'
                      and origin.resolved_at = s.updated_at
                 ) as "fromAlways"
            from runtime_permission_settings s
            left join users su on su.id = s.updated_by_user_id
           where a.decision_stage = 'grant' and a.decision_detail->>'reason' = 'terminal_switch'
             and s.organization_id = a.organization_id
             and s.terminal_danger_always and s.updated_at <= a.resolved_at
           order by s.updated_at desc
           limit 1
        ) st on true
       where a.organization_id = ${organizationId}
         and a.resolved_by_policy is not null
         and a.resolved_at is not null
    )
    select * from entries
     where (${choice} = '' or choice = ${choice})
       and (${botId} = '' or "botId" = ${botId})
       and (${origin} = '' or origin = ${origin})
     order by "issuedAt" desc
     limit 500
  `;
  return rows;
}

/** Les écritures d'accueil portent sur l'organisation : un compte qui n'en a pas la définit d'abord. */
function assertOrganizationDefined(organizationId: string): void {
  if (organizationId === EMPTY_WORKSPACE_ID) {
    throw new HttpError(409, "ORGANIZATION_REQUIRED", "Définissez d’abord votre organisation.");
  }
}
