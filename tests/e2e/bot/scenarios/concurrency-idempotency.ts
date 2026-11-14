import type { Scenario } from "../kit/scenario";
import { completed, preparedBot, requireEvidence } from "../kit/acceptance";

type Admission = { runId: string; message: { id: string }; workflowId: string | null };

export function replayAgreement(admissions: Admission[]): Admission {
  requireEvidence(admissions.length > 0 && admissions.every((entry) => typeof entry.runId === "string" && typeof entry.message?.id === "string"), "An admission lacks its persisted identity.");
  const first = admissions[0]!;
  requireEvidence(admissions.every((entry) => entry.runId === first.runId && entry.message.id === first.message.id && entry.workflowId === first.workflowId), "Replays created different message/run/workflow identities.");
  return first;
}

export const concurrencyIdempotency: Scenario = {
  id: "concurrency-idempotency",
  title: "Concurrence et rejeu d'un envoi",
  summary: "Deux envois simultanés de même clé, une réponse perdue et un rejeu tardif gardent un message, un run et une réponse ; les fils concurrents restent séparés.",
  async run(context) {
    const { lab, session, rec } = context;
    const bot = await preparedBot(context, "E2E Idempotency", "Reply exactly with the marker requested in each user message. Do not use tools.");
    const path = `/api/threads/${bot.threadId}/messages`;
    const key = crypto.randomUUID();
    const marker = `ONCE_${crypto.randomUUID().replaceAll("-", "")}`;
    const body = { input: `Reply exactly ${marker}.` };
    let admission!: Admission;
    const started = Date.now();

    const post = () => session.raw("POST", path, body, { "Idempotency-Key": key });
    await rec.step("Double envoi simultané, même clé", async () => {
      const results = await Promise.all([post(), post()]);
      const admissions: Admission[] = [];
      for (const response of results) {
        if (response.status === 202) admissions.push(await response.json() as Admission);
        else {
          const body = await response.json() as { error?: { code?: string } };
          requireEvidence(response.status === 409 && body.error?.code === "IDEMPOTENCY_IN_PROGRESS", `Unexpected duplicate admission HTTP ${response.status}/${body.error?.code}.`);
        }
      }
      requireEvidence(admissions.length > 0, "Both simultaneous submissions were refused.");
      admission = replayAgreement(admissions);
      return { admittedResponses: admissions.length, uniqueRun: admission.runId };
    });

    await rec.step("Réponse HTTP volontairement perdue, puis retry", async () => {
      const lost = await post();
      requireEvidence(lost.status === 202, `Lost-response replay answered ${lost.status}.`);
      await lost.body?.cancel();
      const response = await post();
      requireEvidence(response.status === 202, `Retry answered ${response.status}.`);
      replayAgreement([admission, await response.json() as Admission]);
      const status = await session.api<{ state: string; response?: { body?: Admission } }>("GET", `/api/threads/${bot.threadId}/submissions/${key}`);
      requireEvidence(status.state === "completed", "Submission recovery endpoint does not confirm completed admission.");
      return { sameRun: true, submissionState: status.state };
    });

    await rec.step("Une clé réutilisée avec un autre message est refusée", async () => {
      const response = await session.raw("POST", path, { input: "Different content" }, { "Idempotency-Key": key });
      const body = await response.json() as { error?: { code?: string } };
      requireEvidence(response.status === 409 && body.error?.code === "IDEMPOTENCY_KEY_REUSED", "Changed-body replay was not refused with IDEMPOTENCY_KEY_REUSED.");
    });

    await rec.step("Un seul run terminé et un seul message assistant persisté", async () => {
      const turn = await lab.follow(admission.runId, started);
      completed(turn, marker);
      requireEvidence(!turn.marks?.toolCalls, "The idempotency text probe unexpectedly used tools.");
      const rows = await lab.db<Array<{ ingress: number; primaryRuns: number; replies: number; remoteRuns: number }>>`
        select
          (select count(*)::int from message_ingress where organization_id = ${session.organizationId} and idempotency_key = ${key}) as ingress,
          (select count(*)::int from runs where bot_id = ${bot.id} and step_kind = 'root' and origin is distinct from 'memory_extract') as "primaryRuns",
          (select count(*)::int from messages where run_id = ${admission.runId} and role = 'assistant') as replies,
          (select count(distinct hermes_run_id)::int from runs where id = ${admission.runId}) as "remoteRuns"`;
      const row = rows[0];
      requireEvidence(row?.ingress === 1 && row.primaryRuns === 1 && row.replies === 1 && row.remoteRuns === 1, "Duplicate ingress, primary execution or assistant persistence detected.");
      const late = await post();
      requireEvidence(late.status === 202, "Replay after completion did not return its stored admission.");
      replayAgreement([admission, await late.json() as Admission]);
      return { ...row, remoteCreationScope: "openedbot persisted identities; not a sealed remote creation audit" };
    });

    await rec.step("Deux fils concurrents gardent leur propre réponse", async () => {
      const other = await preparedBot(context, "E2E Parallel", "Reply exactly with the marker requested. Do not use tools.");
      const a = `THREAD_A_${crypto.randomUUID()}`, b = `THREAD_B_${crypto.randomUUID()}`;
      const [left, right] = await Promise.all([lab.send(bot.threadId, `Reply exactly ${a}.`), lab.send(other.threadId, `Reply exactly ${b}.`)]);
      completed(left, a); completed(right, b);
      requireEvidence(!left.marks?.toolCalls && !right.marks?.toolCalls, "A concurrent text probe unexpectedly used tools.");
      requireEvidence(left.runId !== right.runId && !left.run?.output?.includes(b) && !right.run?.output?.includes(a), "Concurrent thread outputs crossed identities.");
      return { threads: 2, distinctRuns: true };
    });
  },
};
