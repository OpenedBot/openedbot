import type { SQL } from "bun";
import { withTenant } from "../../platform/db/src/db";
import { metricsPeriod, readBusinessMetrics } from "../../modules/runtimes/src/application/business-metrics";
import { readAgencyDirectory } from "../../modules/identity/src/application/agency-directory";

type Context = {
  target: SQL; api: SQL; userId: string; agencyId: string; otherAgencyId: string; clients: [string, string]; outOfMandateClientId: string;
  request: (path: string, organizationId: string, database?: SQL) => Promise<Response>;
};
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

export async function agencyBusinessScenarios(context: Context) {
  const { target, api, userId, agencyId, otherAgencyId, clients: [B, C], outOfMandateClientId, request } = context;
  const now = new Date();
  const period = metricsPeriod(7, now);
  await target`update memberships set revoked_at = null where organization_id = ${otherAgencyId} and user_id = ${userId}`;
  for (const agency of [agencyId, otherAgencyId]) {
    for (const client of agency === agencyId ? [B, C] : [C]) {
      await target`insert into agency_grants (id, agency_organization_id, client_organization_id) values
        (${crypto.randomUUID()}, ${agency}, ${client})`;
    }
  }
  const threads: string[] = [];
  for (const [org, active] of [[B, 1], [C, 2]] as const) {
    const section = crypto.randomUUID(); const bot = crypto.randomUUID();
    await target`insert into sections (id, organization_id, name, position) values (${section}, ${org}, 'Metrics', 0)`;
    for (let index = 0; index < active + (org === B ? 2 : 0); index++) {
      await target`insert into bots (id, organization_id, section_id, name, slug, position, archived_at, deleted_at)
        values (${index === 0 ? bot : crypto.randomUUID()}, ${org}, ${section}, ${`Agent ${index}`}, ${`metric-${index}`}, ${index},
          ${org === B && index >= 1 ? now : null}, ${org === B && index === 2 ? now : null})`;
    }
    const thread = crypto.randomUUID(); threads.push(thread);
    await target`insert into threads (id, organization_id, bot_id, title, hermes_session_id)
      values (${thread}, ${org}, ${bot}, 'Metrics fixture', ${thread})`;
  }
  const run = async (org: string, thread: string, status: string, at: string, tokens: number | null) => {
    const id = crypto.randomUUID();
    await target`insert into runs (id, organization_id, thread_id, input, status, created_at, ended_at, usage)
      values (${id}, ${org}, ${thread}, 'Synthetic metrics fixture', ${status}, ${at}::timestamptz,
        ${status === 'awaiting_approval' ? null : at}::timestamptz, ${tokens === null ? null : { totalTokens: tokens, inputTokens: tokens, outputTokens: 0 }})`;
    return id;
  };
  await run(B, threads[0]!, 'completed', period.from, 10);
  await run(B, threads[0]!, 'completed', new Date(new Date(period.from).getTime() + 1).toISOString(), null);
  await run(B, threads[0]!, 'completed', new Date(new Date(period.from).getTime() - 1).toISOString(), 777);
  await run(B, threads[0]!, 'completed', period.until, 999);
  const pendingRun = await run(B, threads[0]!, 'awaiting_approval', new Date(new Date(period.from).getTime() - 1).toISOString(), null);
  await target`insert into approval_requests (id, organization_id, thread_id, run_id, choices, expires_at)
    values (${crypto.randomUUID()}, ${B}, ${threads[0]!}, ${pendingRun}, ${['once', 'deny']}, ${new Date(now.getTime() + 3600000)})`;
  await run(C, threads[1]!, 'completed', period.from, 50);
  await run(C, threads[1]!, 'failed', period.from, 90);
  const runtimeB = crypto.randomUUID(); const runtimeC = crypto.randomUUID(); const inactive = crypto.randomUUID();
  for (const [id, org, active, health] of [[runtimeB, B, true, 'healthy'], [runtimeC, C, true, 'unauthorized'], [inactive, B, false, 'unreachable']] as const) {
    await target`insert into runtimes (id, organization_id, name, reachability, is_active, last_health_status, link_last_seen_at, link_token_hash)
      values (${id}, ${org}, 'Synthetic runtime observation', 'connector', ${active}, ${health}, ${now}, ${id.replaceAll('-', '').padEnd(64, '0')})`;
  }
  for (const [id, org, provider, kind, expires] of [
    [runtimeB, B, 'openai-api', 'quota', 1], [runtimeC, C, 'anthropic', 'auth', 1],
    [runtimeC, C, 'expired', 'quota', -1], [inactive, B, 'inactive', 'quota', 1],
  ] as const) {
    await target`insert into runtime_provider_incidents (organization_id, runtime_id, provider, kind, until)
      values (${org}, ${id}, ${provider}, ${kind}, ${new Date(now.getTime() + expires * 3600000)})`;
  }

  let first = await (await request('/api/pro/agency/fleet?days=7', agencyId)).json();
  check(first.authorizedTotal === 2 && first.filteredTotal === 2, 'Exact portfolio and filtered totals');
  check(first.period.timezone === 'UTC' && first.period.from === period.from && first.period.until === period.until, 'Explicit calendar range');
  check(first.summary.totals.runsTotal === 4 && first.summary.totals.completed === 3 && first.summary.totals.failed === 1, 'Period boundaries are inclusive/exclusive');
  check(first.summary.totals.tokens === 150 && first.summary.totals.successRate === 75, 'Weighted success and measured OHB tokens');
  check(first.summary.totals.runsRunning === 1 && first.summary.totals.pendingApprovals === 1, 'Current activity is independent of period');
  check(first.summary.totals.providerIncidents === 2 && first.summary.totals.runtimeIncidents === 1,
    'Active provider incidents and persisted runtime alerts are counted, inactive and expired signals excluded');
  check(first.summary.coverage.measuredClients === 1 && first.summary.coverage.unknownClients === 1 && first.summary.state === 'partial', 'Missing usage is named partial');
  const b = first.clients.find((client: any) => client.workspace.id === B);
  const c = first.clients.find((client: any) => client.workspace.id === C);
  check(b.metrics.activeBots === 1 && b.metrics.archivedBots === 1 && c.metrics.activeBots === 2, 'Archive and deleted states are separate');
  const detailBResponse = await request(`/api/pro/agency/clients/${B}?days=7`, agencyId);
  const detailCResponse = await request(`/api/pro/agency/clients/${C}?days=7`, agencyId);
  check(detailBResponse.status === 200 && detailCResponse.status === 200, 'A live exact mandate opens both client details');
  const detailB = await detailBResponse.json();
  const detailC = await detailCResponse.json();
  check(detailB.metrics.activeBots === b.metrics.activeBots && detailB.metrics.archivedBots === b.metrics.archivedBots &&
    detailB.metrics.providerIncidents === b.metrics.providerIncidents && detailB.metrics.runtimeIncidents === b.metrics.runtimeIncidents,
  'Client B detail carries its own RLS-scoped business metrics');
  check(detailC.metrics.activeBots === c.metrics.activeBots && detailC.metrics.archivedBots === c.metrics.archivedBots &&
    detailC.metrics.providerIncidents === c.metrics.providerIncidents && detailC.metrics.runtimeIncidents === c.metrics.runtimeIncidents &&
    detailC.metrics.activeBots !== detailB.metrics.activeBots,
  'Client C detail carries distinct metrics from its own tenant');
  for (const clientId of [outOfMandateClientId, crypto.randomUUID()]) {
    const denied = await request(`/api/pro/agency/clients/${clientId}`, agencyId);
    check(denied.status === 403, 'An existing unmandated or invented client UUID is denied');
    const body = await denied.json();
    check(!('workspace' in body) && !('metrics' in body), 'A denied detail response contains no client data');
  }
  const shared = await withTenant(api, B, (tx) => readBusinessMetrics(tx, B, period, now));
  check(JSON.stringify(shared) === JSON.stringify(b.metrics), 'Client projection uses the shared business reader');
  const forbidden = await withTenant(api, B, (tx) => readBusinessMetrics(tx, C, period, now));
  check(forbidden.runsTotal === 0 && forbidden.activeBots === 0 && forbidden.providerIncidents === 0 && forbidden.runtimeIncidents === 0, 'Invoker function retains tenant RLS');
  const other = await (await request('/api/pro/agency/fleet?days=7', otherAgencyId)).json();
  check(other.authorizedTotal === 1 && other.summary.totals.tokens === 140 && other.summary.state === 'complete', 'Another agency sees only its own grant');
  const filtered = await (await request('/api/pro/agency/fleet?days=7&search=Client%20B', agencyId)).json();
  check(filtered.authorizedTotal === 2 && filtered.filteredTotal === 1 && filtered.summary.totals.tokens === 150, 'Search does not change global aggregates');
  check((await request('/api/pro/agency/fleet?days=0', agencyId)).status === 400, 'Invalid period refused');

  // Relation history has a microsecond timestamp tie: cursor must preserve it.
  await target`delete from membership_events where organization_id in (${B}, ${C}) and subject_organization_id = ${agencyId}`;
  await target`insert into membership_events (id, organization_id, actor_user_id, subject_organization_id, kind, role, occurred_at)
    select ('94000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid, ${B}::uuid, ${userId}::uuid,
      ${agencyId}::uuid, 'agency_granted', 'agency', '2026-01-01T00:00:00.123456Z'::timestamptz from generate_series(1,60) n`;
  await target`insert into membership_events (id, organization_id, actor_user_id, subject_organization_id, kind, role)
    values (${crypto.randomUUID()}, ${B}, ${userId}, ${otherAgencyId}, 'agency_granted', 'agency'),
      (${crypto.randomUUID()}, ${B}, ${userId}, null, 'role_changed', 'admin')`;
  const auditResponse = await request(`/api/pro/agency/clients/${B}/audit`, agencyId);
  check(auditResponse.status === 200, 'Audit route available');
  const audit = await auditResponse.json();
  check(audit.events.length === 50 && audit.hasMore && audit.nextCursor && audit.limit === 50, 'Audit page advertises its cap');
  const older = await (await request(`/api/pro/agency/clients/${B}/audit?after=${encodeURIComponent(audit.nextCursor)}`, agencyId)).json();
  check(older.events.length === 10 && !older.hasMore && older.nextCursor === null, 'Second audit page contains every remaining tied event');
  check(new Set([...audit.events, ...older.events].map((event: any) => event.id)).size === 60, 'Cursor has no duplicate or missing microsecond ties');
  const empty = await (await request(`/api/pro/agency/clients/${C}/audit`, agencyId)).json();
  check(empty.events.length === 0 && !empty.hasMore, 'Empty authorized history is a successful empty page');
  check((await request(`/api/pro/agency/clients/${B}/audit`, otherAgencyId)).status === 403, 'Other agency cannot read this relationship');
  check((await request(`/api/pro/agency/clients/${B}/audit?after=invalid`, agencyId)).status === 400, 'Invalid cursor refused');

  const results: Array<Record<string, unknown>> = [];
  const latencyBudgetMs: Record<number, number> = { 25: 300, 250: 600, 1000: 1500 };
  let previous = 2;
  for (const clients of [25, 250, 1000]) {
    await target`insert into organizations (id, name, slug)
      select ('92000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
        'Scale ' || lpad(n::text,4,'0'), 'scale-' || n::text from generate_series(${previous - 1}, ${clients - 2}) n`;
    await target`insert into agency_grants (id, agency_organization_id, client_organization_id)
      select gen_random_uuid(), ${agencyId}::uuid, ('92000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid
      from generate_series(${previous - 1}, ${clients - 2}) n`;
    previous = clients;
    await target`analyze organizations`; await target`analyze agency_grants`;
    const timings: number[] = []; const transactions: number[] = []; const concurrency: number[] = [];
    for (let sample = 0; sample < 7; sample++) {
      let count = 0; let active = 0; let peak = 0;
      const counted = new Proxy(api, { get(sql, key) {
        if (key === 'begin') return (callback: any) => {
          count++; active++; peak = Math.max(peak, active);
          return sql.begin(callback).finally(() => { active--; });
        };
        const value = Reflect.get(sql, key); return typeof value === 'function' ? value.bind(sql) : value;
      } });
      const started = performance.now();
      const response = await request('/api/pro/agency/fleet?days=7', agencyId, counted);
      const page = await response.json();
      timings.push(Math.round((performance.now() - started) * 100) / 100); transactions.push(count); concurrency.push(peak);
      check(response.status === 200 && page.clients.length === 25 && page.authorizedTotal === clients, 'One bounded page at every portfolio size');
      check(page.summary.totals.tokens === 150 && page.summary.totals.runsTotal === 4, 'Scale clients do not fabricate activity');
      check(count <= 28 && peak <= 5, 'Bounded transaction count: auth, directory, summary and 25 clients; max four clients plus summary');
    }
    timings.sort((a,b) => a-b);
    results.push({ clients, latencyBudgetMs: latencyBudgetMs[clients], samples: timings.length, p50Ms: timings[3], p95Ms: timings[6], maxMs: timings[6],
      minTransactions: Math.min(...transactions), maxTransactions: Math.max(...transactions), peakRequestedTransactions: Math.max(...concurrency), errors: 0 });
    const budgetPassed = timings[6]! <= latencyBudgetMs[clients]!;
    console.log(JSON.stringify({ kind: "agency.performance.sample", ...results.at(-1), budgetPassed }));
    if (process.env.AGENCY_ENFORCE_PERF_BUDGET === "1") check(budgetPassed, "Pilot fleet p95 exceeds its documented local budget");
    first = await (await request('/api/pro/agency/fleet?days=7&page=1', agencyId)).json();
    check(first.summary.totals.tokens === 150 && first.authorizedTotal === clients, 'Totals stay stable on a second page');
  }
  const page0 = await readAgencyDirectory(api, userId, agencyId, 0, 'Scale');
  const page1 = await readAgencyDirectory(api, userId, agencyId, 1, 'Scale');
  check(page0.workspaces.length === 25 && page1.workspaces.length === 25 && !page1.workspaces.some((client) => page0.workspaces.some((first) => first.id === client.id)), 'Stable name/id page order');

  const broken = (match: string, organizationId?: string) => new Proxy(api, { get(sql, key) {
    if (key === 'begin') return (callback: any) => sql.begin((tx) => callback(new Proxy(tx, { apply(query, receiver, args) {
      if (args[0]?.join?.('').includes(match) && (!organizationId || args.includes(organizationId))) throw new Error('synthetic internal SQL details');
      return Reflect.apply(query, receiver, args);
    } })));
    const value = Reflect.get(sql, key); return typeof value === 'function' ? value.bind(sql) : value;
  } });
  const partial = await (await request('/api/pro/agency/fleet?days=7', agencyId, broken('workspace_business_metrics', B))).json();
  const unreadable = partial.clients.find((client: any) => client.workspace.id === B);
  check(unreadable.error && unreadable.errorCode === 'CLIENT_READ_FAILED' && unreadable.metrics === null, 'One client failure does not become zero measurements');
  check(!JSON.stringify(partial).includes('synthetic internal SQL details'), 'Partial error hides internal SQL details');
  const unavailable = await (await request('/api/pro/agency/fleet?days=7', agencyId, broken('agency_business_summary'))).json();
  check(unavailable.summary.state === 'unavailable' && unavailable.summary.totals === null && unavailable.summary.coverage.unreadableClients === 1000, 'Atomic summary failure names unavailable coverage');
  check(!JSON.stringify(unavailable).includes('synthetic internal SQL details'), 'Summary failure hides internal SQL details');
  await target`update agency_grants set revoked_at = now() where agency_organization_id = ${agencyId} and client_organization_id = ${B}`;
  await target`update memberships set role = 'owner', revoked_at = null where organization_id = ${B} and user_id = ${userId}`;
  check((await request(`/api/pro/agency/clients/${B}/audit`, agencyId)).status === 403, 'Revoked exact mandate cannot borrow direct owner privileges');
  await target`update memberships set revoked_at = now() where organization_id = ${agencyId} and user_id = ${userId}`;
  let denied = false;
  try { await readAgencyDirectory(api, userId, agencyId, 0); } catch { denied = true; }
  check(denied, 'Definer directory independently refuses a revoked agency membership');
  console.log('Agency business integration passed: exact grants, RLS, UTC boundaries, usage coverage, cursor paging and injected partial errors.');
  console.log(JSON.stringify({ measuredAt: new Date().toISOString(), environment: 'disposable PostgreSQL; ohb_api RLS; seven samples per size', measurements: results }));
}
