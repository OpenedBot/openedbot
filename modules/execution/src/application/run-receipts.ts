import type { SQL } from "bun";
import { appendRunEventsTx } from "../sql/run-events";

type ReceiptRow = {
  runId: string;
  threadId: string;
  payload: Record<string, unknown>;
};

export type RunJournalEvent = ReceiptRow & {
  organizationId: string;
  type: "run.error" | "system.notice";
};

type Journal = { steering: Map<string, Set<string>>; events: RunJournalEvent[] };
const journals = new WeakMap<object, Journal>();

export function captureRunEventTx(tx: SQL, event: RunJournalEvent): void {
  const journal = journals.get(tx);
  if (!journal) throw new Error("Run event requires a journal transaction");
  journal.events.push(event);
}

export function captureSteeringReceiptTx(tx: SQL, organizationId: string, attemptId: string): void {
  const changes = journals.get(tx)?.steering;
  if (!changes) throw new Error("Steering receipt requires a journal transaction");
  const ids = changes.get(organizationId) ?? new Set<string>();
  ids.add(attemptId);
  changes.set(organizationId, ids);
}

export async function withRunReceiptJournalTx<T>(tx: SQL, work: (tx: SQL) => Promise<T>): Promise<T> {
  if (journals.has(tx)) return work(tx);
  const journal: Journal = { steering: new Map(), events: [] };
  journals.set(tx, journal);
  try {
    const result = await work(tx);
    await flushRunJournalTx(tx, [...journal.steering].map(([organizationId, ids]) => ({
      organizationId, attemptIds: [...ids],
    })), journal.events);
    return result;
  } finally {
    journals.delete(tx);
  }
}

export function withRunReceiptJournal<T>(db: SQL, work: (tx: SQL) => Promise<T>): Promise<T> {
  return db.begin((tx) => withRunReceiptJournalTx(tx as SQL, work)) as Promise<T>;
}

type ReceiptInput = {
  organizationId: string;
  messageIds?: readonly string[];
  attemptIds?: readonly string[];
};

type JournalRow = ReceiptRow & { type: "message.admitted" | "run.steering" | RunJournalEvent["type"] };

/** Call last in the business transaction, after its run/workflow/attempt locks. */
export async function recordRunReceiptsTx(tx: SQL, input: ReceiptInput): Promise<void> {
  await flushRunJournalTx(tx, [input], []);
}

async function readReceiptsTx(tx: SQL, input: ReceiptInput): Promise<JournalRow[]> {
  const messageIds = [...new Set(input.messageIds ?? [])];
  const attemptIds = [...new Set(input.attemptIds ?? [])];
  const messages = messageIds.length ? await tx<ReceiptRow[]>`
    select run.id as "runId", message.thread_id as "threadId",
           jsonb_build_object('messageId', message.id, 'runId', run.id,
             'status', run.status, 'workflowId', run.workflow_id) as payload
      from messages message join runs run on run.organization_id = message.organization_id and run.id = message.run_id
     where message.organization_id = ${input.organizationId} and message.id in ${tx(messageIds)}
       and message.role = 'user' and message.author_bot_id is null
     order by message.created_at, message.id
  ` : [];
  const attempts = attemptIds.length ? await tx<ReceiptRow[]>`
    select steer.source_run_id as "runId", steer.thread_id as "threadId",
           jsonb_build_object('attemptId', steer.id, 'sourceRunId', steer.source_run_id,
             'targetRunId', steer.target_run_id, 'status', steer.status, 'attempts', steer.attempts,
             'errorCode', case when split_part(steer.error_code, ':', 1) ~ '^[A-Z0-9_]{1,80}$'
               then split_part(steer.error_code, ':', 1) else null end) as payload
      from run_steering_attempts steer
     where steer.organization_id = ${input.organizationId} and steer.id in ${tx(attemptIds)}
     order by steer.created_at, steer.id
  ` : [];
  return [
    ...messages.map((row): JournalRow => ({ ...row, type: "message.admitted" })),
    ...attempts.map((row): JournalRow => ({ ...row, type: "run.steering" })),
  ];
}

async function flushRunJournalTx(tx: SQL, inputs: ReceiptInput[], events: RunJournalEvent[]): Promise<void> {
  const organizations = new Map<string, JournalRow[]>();
  for (const input of inputs) {
    const rows = await readReceiptsTx(tx, input);
    if (rows.length) organizations.set(input.organizationId, [...(organizations.get(input.organizationId) ?? []), ...rows]);
  }
  for (const event of events) {
    organizations.set(event.organizationId, [...(organizations.get(event.organizationId) ?? []), event]);
  }
  // One append for every organization: the primitive locks every source run,
  // then every cursor, before numbering. A receipt never uses the active
  // target's sequence, owned by its Hermes normalizer.
  await appendRunEventsTx(tx, [...organizations].flatMap(([organizationId, rows]) => rows.map((row) => ({
    organizationId, threadId: row.threadId, runId: row.runId, type: row.type, payload: row.payload,
  }))));
}
