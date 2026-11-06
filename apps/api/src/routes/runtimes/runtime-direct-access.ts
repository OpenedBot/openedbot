import {
  HermesClient,
  HermesClientError,
  normalizeHermesEndpoint,
  type HermesClientConfig,
} from "@openedbot/hermes";
import { runtimeAdminClient } from "@openedbot/runtimes/application/runtime-admin-client";
import type { ApiConfig } from "../../infrastructure/config";
import {
  encryptSecret,
} from "../../infrastructure/crypto";
import { pgTextArray } from "@openedbot/runtime-link/application/broker";
import type {
  RuntimeDirectProbeDto,
  RuntimeProbeDiagnosticCode,
  RuntimeProbeStep,
} from "@openedbot/contracts-api";
import { assertString, HttpError } from "../../interfaces/http/http-error";
import {
  assertRuntimeToolsetContract,
  runtimeCapacity,
  type RuntimeProbeClient,
} from "@openedbot/runtimes/application/runtime-probe";
import { readRuntimeRowById, type RuntimeRow } from "@openedbot/runtimes/application/runtime-rows";
import {
  decryptEdgeAuth,
  decryptRuntimeToken,
  directConfig,
  directCredentials,
  optionalDirectToken,
  readEdgeAuthInput,
} from "@openedbot/runtimes/application/runtime-access";

export function insertRuntime(
  tx: Bun.TransactionSQL,
  input: {
    organizationId: string;
    name: string;
    endpoint: string;
    encrypted: { ciphertext: string; nonce: string; tag: string };
    keyId: string;
    edge?: { ciphertext: string; nonce: string; tag: string } | null;
    capacity: number;
    /** Ce que `GET /hermes-setup/capabilities` a rendu à la sonde ; vide si l'hôte n'a pas répondu. */
    hostFeatures: string[];
    active: boolean;
  },
) {
  return tx<RuntimeRow[]>`
    insert into runtimes (
      id, organization_id, name, endpoint, token_ciphertext, token_nonce, token_tag, token_key_id,
      capacity, last_health_status, last_health_error, last_probed_at, is_active, link_features,
      edge_auth_ciphertext, edge_auth_nonce, edge_auth_tag, edge_auth_key_id
    ) values (
      ${crypto.randomUUID()}, ${input.organizationId}, ${input.name}, ${input.endpoint},
      ${input.encrypted.ciphertext}, ${input.encrypted.nonce}, ${input.encrypted.tag}, ${input.keyId},
      ${input.capacity}, 'healthy', null, now(), ${input.active}, ${pgTextArray(input.hostFeatures)}::text[],
      ${input.edge?.ciphertext ?? null}, ${input.edge?.nonce ?? null}, ${input.edge?.tag ?? null}, ${input.edge ? input.keyId : null}
    )
    returning id, name, endpoint, token_ciphertext as "tokenCiphertext", token_nonce as "tokenNonce",
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
           link_agent as "linkAgent", link_agent_seen_at as "linkAgentSeenAt", link_hermes_version as "linkHermesVersion",
           link_origin as "linkOrigin",
           link_token_rotated_at as "linkRotatedAt",
           (select max(e.occurred_at) from runtime_link_events e
             where e.organization_id = runtimes.organization_id and e.runtime_id = runtimes.id and e.kind = 'replaced') as "linkLastReplacedAt",
           (select max(e.occurred_at) from runtime_link_events e
             where e.organization_id = runtimes.organization_id and e.runtime_id = runtimes.id and e.kind = 'hijack_suspected') as "linkHijackSuspectedAt"
  `;
}

export function defaultProbeClient(clientConfig: HermesClientConfig): RuntimeProbeClient {
  return runtimeAdminClient(clientConfig);
}

export type DirectRuntimeProbe = {
  capacity: number;
  /** Compatibility field: direct access never advertises host features. */
  hostFeatures: string[] | null;
};

/** Gateway health, capabilities and root toolset contract; never an operator probe. */
export async function probeDirectRuntime(
  endpoint: string,
  token: string,
  config: ApiConfig,
  clientFactory: (clientConfig: HermesClientConfig) => RuntimeProbeClient = defaultProbeClient,
): Promise<DirectRuntimeProbe> {
  const client = clientFactory({
    endpoint,
    token,
    policy: config.hermesEndpointPolicy,
    mtls: config.hermesMtls,
  });
  const capacity = await probeDirectCapacityWith(client);
  return { capacity, hostFeatures: [] };
}

/** Une ligne connector n'accepte jamais d'URL ni de bearer côté openedbot. */
export function assertReachabilityMutable(row: RuntimeRow | null): void {
  if (row && row.reachability !== "direct") {
    throw new HttpError(
      409,
      "RUNTIME_REACHABILITY_IMMUTABLE",
      "Ce runtime est joint par le connecteur : son URL et son token ne se modifient pas ici.",
    );
  }
}

/**
 * Le token à employer pour sonder un BROUILLON.
 *
 * Le token enregistré n'est réutilisé que pour SON endpoint. Sans cette
 * égalité, un brouillon pointant vers un hôte arbitraire ferait envoyer le
 * secret de l'organisation à cet hôte : la vérification deviendrait une fuite
 * de secret déclenchable par tout admin.
 */
export function draftRuntimeToken(
  endpoint: string,
  suppliedToken: string,
  existing: { endpoint: string; token: string } | null,
): string | null {
  if (suppliedToken) return suppliedToken;
  if (existing && existing.endpoint === endpoint) return existing.token;
  return null;
}

/**
 * L'accès direct à écrire, et les secrets avec lesquels le sonder.
 *
 * Un secret enregistré ne repart JAMAIS que vers SON endpoint. C'est la règle
 * que `draftRuntimeToken` portait pour les brouillons ; elle vaut pour toute
 * écriture, et ne pas la reprendre ici a été une vraie fuite : changer la
 * seule URL, en laissant le champ du bearer vide comme l'écran le fait déjà,
 * suffisait à faire envoyer à l'hôte de son choix le bearer Hermes de
 * l'organisation et son service token Cloudflare Access. Ces deux secrets sont
 * en écriture seule partout ailleurs dans l'API (`publicRuntime` n'en rend que
 * `tokenConfigured`), donc un `admin` invité, qui ne les a jamais possédés,
 * pouvait les extraire. La route `/:runtimeId/access` persistant l'endpoint,
 * les runs suivants y expédiaient en plus les conversations du tenant.
 *
 * Un hôte nouveau exige donc son propre bearer. Une modification d'URL
 * légitime échoue en 400 tant que le bearer n'est pas ressaisi : c'est le bon
 * sens de l'échec, et l'écran le redemande.
 */
export function prepareDirectAccess(body: Record<string, unknown>, existing: RuntimeRow | null, config: ApiConfig) {
  const url = body.url === undefined && existing ? directCredentials(existing).endpoint : assertString(body.url, "L’URL Hermes", { max: 2_048 });
  // Comparé après normalisation des deux côtés, pour qu'une URL qui ne diffère
  // que par sa forme reste le même hôte et n'oblige pas à ressaisir le bearer.
  // La comparaison ne juge PAS l'URL : une URL refusée par la politique
  // (Quick Tunnel, schéma interdit) n'est simplement « pas le même hôte », et
  // c'est `normalizeHermesEndpoint` plus bas qui rend son propre diagnostic,
  // au même moment qu'avant. Sans ça, l'erreur de forme masquerait celle de
  // politique et un Quick Tunnel repartait en 500 au lieu de son refus nommé.
  const sameEndpoint = (a: string, b: string): boolean => {
    try {
      return normalizeHermesEndpoint(a, config.hermesEndpointPolicy) === normalizeHermesEndpoint(b, config.hermesEndpointPolicy);
    } catch {
      return false;
    }
  };
  const sameHost = existing !== null && sameEndpoint(directCredentials(existing).endpoint, url);
  const reusable = sameHost ? existing : null;
  const token = body.token === undefined && reusable ? decryptRuntimeToken(reusable, config).value : optionalDirectToken(body.token);
  if (!token) {
    throw new HttpError(400, "RUNTIME_TOKEN_REQUIRED", existing && !sameHost
      ? "Cette URL Hermes est nouvelle : elle exige son propre bearer, celui enregistré ne la suit pas."
      : "Le bearer Hermes est requis.");
  }
  const edgeAuth = body.edgeAuth === undefined && reusable ? decryptEdgeAuth(reusable, config) : readEdgeAuthInput(body.edgeAuth);
  const client = directConfig(url, token, edgeAuth, config);
  return { endpoint: normalizeHermesEndpoint(url, config.hermesEndpointPolicy), client,
    encrypted: encryptSecret(token, config.tokenEncryption.current.value),
    edge: edgeAuth ? encryptSecret(JSON.stringify(edgeAuth), config.tokenEncryption.current.value) : null };
}

export async function updateDirectAccess(tx: Bun.TransactionSQL, organizationId: string, id: string,
  access: ReturnType<typeof prepareDirectAccess>, config: ApiConfig, name?: string): Promise<RuntimeRow> {
  await tx`update runtimes set endpoint = ${access.endpoint}, name = coalesce(${name ?? null}, name),
    token_ciphertext = ${access.encrypted.ciphertext}, token_nonce = ${access.encrypted.nonce},
    token_tag = ${access.encrypted.tag}, token_key_id = ${config.tokenEncryption.current.id},
    edge_auth_ciphertext = ${access.edge?.ciphertext ?? null}, edge_auth_nonce = ${access.edge?.nonce ?? null},
    edge_auth_tag = ${access.edge?.tag ?? null}, edge_auth_key_id = ${access.edge ? config.tokenEncryption.current.id : null},
    last_health_status = 'unknown', last_health_error = null, last_probed_at = null,
    link_features = '{}'::text[], updated_at = now()
    where organization_id = ${organizationId} and id = ${id} and reachability = 'direct' and revoked_at is null`;
  const row = (await readRuntimeRowById(tx, organizationId, id))[0];
  if (!row) throw new HttpError(404, "RUNTIME_NOT_FOUND", "Ce runtime n’existe pas.");
  return row;
}

/** Three ordered proofs; a named diagnosis always requires specific evidence. */
export async function directProbeResult(factory: () => RuntimeProbeClient, edgeAuthConfigured = false): Promise<RuntimeDirectProbeDto> {
  const result: RuntimeDirectProbeDto = { ok: false, capabilities: null, hints: null,
    steps: ["edge", "auth", "toolsets"].map((step) => ({ step: step as RuntimeProbeStep, ok: null })) };
  let current = 0;
  try {
    const client = factory();
    let capabilities: unknown;
    if (client.health && client.capabilities) {
      const health = await client.health();
      if (!health || typeof health !== "object" || Array.isArray(health)
        || (!("ok" in health && health.ok === true) && !("status" in health && ["ok", "healthy"].includes(String(health.status))))) throw new Error();
      result.steps[0]!.ok = true;
      current = 1;
      capabilities = await client.capabilities();
    } else {
      const probe = await client.probe();
      result.steps[0]!.ok = true;
      current = 1;
      capabilities = probe.capabilities;
    }
    if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) throw new Error();
    // Do not expose arbitrary fields returned by a remote gateway.
    result.capabilities = { max_concurrent_runs: runtimeCapacity(capabilities) };
    result.steps[1]!.ok = true;
    current = 2;
    await assertRuntimeToolsetContract(client);
    result.steps[2]!.ok = true;
    result.ok = true;
  } catch (error) {
    const evidence = HermesClient.directResponseEvidence(error);
    if (evidence) result.hints = { status: evidence.status, contentType: evidence.contentType,
      cloudflare: evidence.cloudflare, accessRedirect: evidence.accessRedirect };
    let code: RuntimeProbeDiagnosticCode = "RUNTIME_PROBE_INDETERMINATE";
    if (error instanceof Error && error.name === "RUNTIME_QUICK_TUNNEL_REFUSED") code = "RUNTIME_QUICK_TUNNEL_REFUSED";
    else if (error instanceof HermesClientError && error.code === "HERMES_DNS_FAILED") code = "RUNTIME_DNS_UNRESOLVED";
    else if (evidence?.accessRedirect) code = edgeAuthConfigured ? "RUNTIME_EDGE_AUTH_REJECTED" : "RUNTIME_EDGE_AUTH_REQUIRED";
    else if (evidence?.status === 530 && evidence.cloudflareCode === "1033") code = "RUNTIME_TUNNEL_DOWN";
    else if (evidence?.gatewayAuth && [401, 403].includes(evidence.status)) code = "RUNTIME_BEARER_REJECTED";
    else if (evidence?.status === 404 && current === 0 && !evidence.cloudflare) code = "RUNTIME_NOT_HERMES";
    else if (evidence?.status === 404 && current === 1) code = "RUNTIME_CAPABILITIES_MISSING";
    else if (error instanceof HttpError && error.code === "HERMES_FORBIDDEN_TOOLSETS_ACTIVE") code = "RUNTIME_TOOLSET_FORBIDDEN";
    result.steps[current] = { step: result.steps[current]!.step, ok: false, code };
  }
  return result;
}

export async function probeDirectCapacityWith(client: RuntimeProbeClient): Promise<number> {
  const result = await directProbeResult(() => client);
  if (!result.ok) {
    throw new HttpError(502, result.steps.find((step) => step.ok === false)?.code ?? "RUNTIME_PROBE_INDETERMINATE",
      "La sonde d’accès direct a échoué. Testez les accès pour consulter les trois preuves.");
  }
  return runtimeCapacity(result.capabilities);
}
