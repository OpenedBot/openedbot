import type { SQL } from "bun";

export type RuntimeModelSelectionProof = {
  runtime_id: string;
  organization_id: string;
  provider: string | null;
  model: string | null;
  reasoning_effort: string | null;
  status: "queued" | "running" | "failed";
  request_generation: number;
  request_id: string;
  attempts: number;
  next_attempt_at: Date;
  error: { code: string; message: string } | null;
  lease_owner: string | null;
  lease_generation: number;
  lease_token: string | null;
  lease_expires_at: Date | null;
  requested_at: Date;
};

export type ProvenRuntimeModel = { organization_id: string; runtime_id: string; provider: string; model: string; proven_at: Date };

export async function readProvenRuntimeModel(db: SQL, organizationId: string, runtimeId: string, provider: string, model: string): Promise<ProvenRuntimeModel | null> {
  const rows = await db<ProvenRuntimeModel[]>`
    select organization_id, runtime_id, provider, model, proven_at from runtime_model_proven
     where organization_id = ${organizationId} and runtime_id = ${runtimeId}
       and provider = ${provider} and model = ${model}
       and proven_at > now() - interval '24 hours'
     for update
  `;
  return rows[0] ?? null;
}

export async function upsertProvenRuntimeModel(db: SQL, input: { organizationId: string; runtimeId: string; provider: string; model: string }): Promise<void> {
  await db`
    insert into runtime_model_proven (organization_id, runtime_id, provider, model, proven_at)
    values (${input.organizationId}, ${input.runtimeId}, ${input.provider}, ${input.model}, now())
    on conflict (runtime_id, provider, model) do update set proven_at = now(), organization_id = excluded.organization_id
  `;
}

export async function invalidateProvenRuntimeModels(db: SQL, organizationId: string, runtimeId: string, provider?: string): Promise<void> {
  if (provider === undefined) {
    await db`delete from runtime_model_proven where organization_id = ${organizationId} and runtime_id = ${runtimeId}`;
  } else {
    await db`delete from runtime_model_proven where organization_id = ${organizationId} and runtime_id = ${runtimeId} and provider = ${provider}`;
  }
}

export async function readModelSelectionProof(db: SQL, organizationId: string, runtimeId: string): Promise<RuntimeModelSelectionProof | null> {
  const rows = await db<RuntimeModelSelectionProof[]>`
    select * from runtime_model_selection_proofs
     where organization_id = ${organizationId} and runtime_id = ${runtimeId}
  `;
  return rows[0] ?? null;
}

export async function upsertModelSelectionProof(
  db: SQL,
  input: { organizationId: string; runtimeId: string; provider: string | null; model: string | null; reasoningEffort: string | null },
): Promise<RuntimeModelSelectionProof> {
  const requestId = crypto.randomUUID();
  const rows = await db<RuntimeModelSelectionProof[]>`
    insert into runtime_model_selection_proofs
      (runtime_id, organization_id, provider, model, reasoning_effort, status, request_id,
       request_generation, attempts, next_attempt_at, error, requested_at, updated_at, finished_at)
    values (${input.runtimeId}, ${input.organizationId}, ${input.provider}, ${input.model}, ${input.reasoningEffort},
            'queued', ${requestId}, 1, 0, now(), null, now(), now(), null)
    on conflict (runtime_id) do update set
      provider = excluded.provider, model = excluded.model, reasoning_effort = excluded.reasoning_effort,
      request_id = excluded.request_id,
      status = 'queued', request_generation = runtime_model_selection_proofs.request_generation + 1,
      attempts = 0, next_attempt_at = now(), error = null, requested_at = now(), updated_at = now(), finished_at = null
    returning *
  `;
  return rows[0]!;
}

export async function deleteModelSelectionProof(db: SQL, organizationId: string, runtimeId: string): Promise<void> {
  await db`delete from runtime_model_selection_proofs where organization_id = ${organizationId} and runtime_id = ${runtimeId}`;
}
