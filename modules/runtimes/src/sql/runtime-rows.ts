import type { Db } from "@openedbot/platform-db";
import type { RuntimeReachability } from "@openedbot/contracts-api";

/**
 * Une ligne `runtimes`. La base tient la forme (0024) : `direct` ⇔ endpoint
 * et token_* renseignés ; `connector` ⇔ tous NULL, aucune URL composable.
 * Le hash du jeton de lien n'est jamais sélectionné ici.
 */
export type RuntimeRow = {
  id: string;
  name: string;
  reachability: RuntimeReachability;
  endpoint: string | null;
  tokenCiphertext: string | null;
  tokenNonce: string | null;
  tokenTag: string | null;
  tokenKeyId: string | null;
  edgeAuthCiphertext?: string | null;
  edgeAuthNonce?: string | null;
  edgeAuthTag?: string | null;
  edgeAuthKeyId?: string | null;
  linkConnectedAt: Date | null;
  linkLastSeenAt: Date | null;
  /**
   * Bail de socket ordonné par la base (0051), en texte : une observation faite
   * par un lien ne s'écrit que si c'est encore ce lien qui tient le runtime.
   * Absent des anciennes projections : sans lui, aucune écriture d'observation.
   */
  linkGeneration?: string | null;
  /** Dernière déclaration du connecteur (0055), absente des anciennes projections. */
  linkAgent?: string | null;
  /** Origine signée à la dernière preuve (0110). Absente des projections qui ne la lisent pas. */
  linkOrigin?: string | null;
  linkAgentSeenAt?: Date | null;
  /** Host features announced by connector hello; direct runtimes expose none. */
  linkFeatures: string[];
  /** Dernière rotation du jeton de lien (0027) ; `null` si jamais tourné. */
  linkRotatedAt: Date | null;
  /** Dernier événement `replaced` du journal du lien (0027). */
  linkLastReplacedAt: Date | null;
  /** Dernier événement `hijack_suspected` du journal du lien (0027). */
  linkHijackSuspectedAt: Date | null;
  selectedProvider: string | null;
  selectedModel: string | null;
  reasoningEffort: string | null;
  capacity: number;
  lastHealthStatus: string;
  lastHealthError: string | null;
  lastProbedAt: Date | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Le runtime ACTIF de l'organisation. Une organisation peut en déclarer
 * plusieurs (local, VPS, lab) mais un seul sert les runs, et c'est l'index
 * partiel `runtimes_one_active_per_org` qui le garantit, pas ce filtre.
 */
export function readRuntimeRows(tx: Bun.TransactionSQL, organizationId: string) {
  return tx<RuntimeRow[]>`
    select id, name, endpoint, token_ciphertext as "tokenCiphertext", token_nonce as "tokenNonce",
           token_tag as "tokenTag", token_key_id as "tokenKeyId",
           edge_auth_ciphertext as "edgeAuthCiphertext", edge_auth_nonce as "edgeAuthNonce",
           edge_auth_tag as "edgeAuthTag", edge_auth_key_id as "edgeAuthKeyId", capacity, last_health_status as "lastHealthStatus",
           last_health_error as "lastHealthError", last_probed_at as "lastProbedAt",
           selected_provider as "selectedProvider", selected_model as "selectedModel",
           reasoning_effort as "reasoningEffort", is_active as "isActive",
           created_at as "createdAt", updated_at as "updatedAt",
           reachability, link_connected_at as "linkConnectedAt", link_last_seen_at as "linkLastSeenAt",
           link_generation::text as "linkGeneration",
           link_features as "linkFeatures",
           link_agent as "linkAgent", link_agent_seen_at as "linkAgentSeenAt",
           link_origin as "linkOrigin",
           link_token_rotated_at as "linkRotatedAt",
           (select max(e.occurred_at) from runtime_link_events e
             where e.organization_id = runtimes.organization_id and e.runtime_id = runtimes.id and e.kind = 'replaced') as "linkLastReplacedAt",
           (select max(e.occurred_at) from runtime_link_events e
             where e.organization_id = runtimes.organization_id and e.runtime_id = runtimes.id and e.kind = 'hijack_suspected') as "linkHijackSuspectedAt"
      from runtimes
     where organization_id = ${organizationId} and revoked_at is null and is_active
     limit 1
  `;
}

/** Tous les runtimes déclarés, actif en tête puis du plus récent au plus ancien. */
export function readAllRuntimeRows(tx: Bun.TransactionSQL, organizationId: string) {
  return tx<RuntimeRow[]>`
    select id, name, endpoint, token_ciphertext as "tokenCiphertext", token_nonce as "tokenNonce",
           token_tag as "tokenTag", token_key_id as "tokenKeyId",
           edge_auth_ciphertext as "edgeAuthCiphertext", edge_auth_nonce as "edgeAuthNonce",
           edge_auth_tag as "edgeAuthTag", edge_auth_key_id as "edgeAuthKeyId", capacity, last_health_status as "lastHealthStatus",
           last_health_error as "lastHealthError", last_probed_at as "lastProbedAt",
           selected_provider as "selectedProvider", selected_model as "selectedModel",
           reasoning_effort as "reasoningEffort", is_active as "isActive",
           created_at as "createdAt", updated_at as "updatedAt",
           reachability, link_connected_at as "linkConnectedAt", link_last_seen_at as "linkLastSeenAt",
           link_generation::text as "linkGeneration",
           link_features as "linkFeatures",
           link_agent as "linkAgent", link_agent_seen_at as "linkAgentSeenAt",
           link_origin as "linkOrigin",
           link_token_rotated_at as "linkRotatedAt",
           (select max(e.occurred_at) from runtime_link_events e
             where e.organization_id = runtimes.organization_id and e.runtime_id = runtimes.id and e.kind = 'replaced') as "linkLastReplacedAt",
           (select max(e.occurred_at) from runtime_link_events e
             where e.organization_id = runtimes.organization_id and e.runtime_id = runtimes.id and e.kind = 'hijack_suspected') as "linkHijackSuspectedAt"
      from runtimes
     where organization_id = ${organizationId} and revoked_at is null
     order by is_active desc, created_at desc
  `;
}

export function readRuntimeRowById(tx: Bun.TransactionSQL, organizationId: string, runtimeId: string) {
  return tx<RuntimeRow[]>`
    select id, name, endpoint, token_ciphertext as "tokenCiphertext", token_nonce as "tokenNonce",
           token_tag as "tokenTag", token_key_id as "tokenKeyId",
           edge_auth_ciphertext as "edgeAuthCiphertext", edge_auth_nonce as "edgeAuthNonce",
           edge_auth_tag as "edgeAuthTag", edge_auth_key_id as "edgeAuthKeyId", capacity, last_health_status as "lastHealthStatus",
           last_health_error as "lastHealthError", last_probed_at as "lastProbedAt",
           selected_provider as "selectedProvider", selected_model as "selectedModel",
           reasoning_effort as "reasoningEffort", is_active as "isActive",
           created_at as "createdAt", updated_at as "updatedAt",
           reachability, link_connected_at as "linkConnectedAt", link_last_seen_at as "linkLastSeenAt",
           link_generation::text as "linkGeneration",
           link_features as "linkFeatures",
           link_agent as "linkAgent", link_agent_seen_at as "linkAgentSeenAt",
           link_origin as "linkOrigin",
           link_token_rotated_at as "linkRotatedAt",
           (select max(e.occurred_at) from runtime_link_events e
             where e.organization_id = runtimes.organization_id and e.runtime_id = runtimes.id and e.kind = 'replaced') as "linkLastReplacedAt",
           (select max(e.occurred_at) from runtime_link_events e
             where e.organization_id = runtimes.organization_id and e.runtime_id = runtimes.id and e.kind = 'hijack_suspected') as "linkHijackSuspectedAt"
      from runtimes
     where organization_id = ${organizationId} and id = ${runtimeId} and revoked_at is null
     limit 1
  `;
}

/** Résultat d'une sonde d'un runtime `direct` : sain, ou injoignable avec son code d'erreur. */
export async function recordDirectProbeResult(
  tx: Db,
  input: { runtimeId: string; organizationId: string; errorCode: string | null },
): Promise<void> {
  await tx`update runtimes set last_health_status = ${input.errorCode ? "unreachable" : "healthy"},
        last_health_error = ${input.errorCode}, last_probed_at = now(), updated_at = now()
        where id = ${input.runtimeId} and organization_id = ${input.organizationId} and reachability = 'direct'`;
}
