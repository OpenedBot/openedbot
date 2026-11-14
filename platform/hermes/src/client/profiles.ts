import {
  PROVIDER_MUTATION_TIMEOUT_MS,
  PROFILE_INVENTORY_TIMEOUT_MS,
  PROFILE_AVATAR_TIMEOUT_MS,
  PROFILE_MUTATION_TIMEOUT_MS,
  PROFILE_SLUG_PATTERN,
  TOOLSET_KEY_PATTERN,
  SKILL_NAME_PATTERN,
  PROVIDER_SLUG_PATTERN,
  MCP_NAME_PATTERN,
  type HermesCreatedHostProfile,
  type HermesProfileInventory,
  type HermesProfileAvatar,
  type HermesProfileToolsetState,
  type HermesProfileMemory,
  type HermesProfileMemoryWrite,
  type HermesProfileMcpServerState,
  type HermesProfileMcpServerRemoval,
  type HermesProfileSkillState,
  type HermesProfileBundledSkillsState,
  type HermesProfileModelState,
  type HermesProfileModelBatchEntry,
  PROFILE_MODEL_BATCH_MAX,
  type HermesHostProfileCreateOptions,
  type HermesProfileCredentialResult,
  type HermesApprovalPolicyMode,
  type HermesApprovalPolicyState,
} from "../contracts";
import { HermesClientError } from "../errors";
import {
  parseHostProfileAvatar as parseHostProfileAvatarResponse,
  parseHostProfileCreateResult as parseHostProfileCreateResultResponse,
  parseHostProfileInventory as parseHostProfileInventoryResponse,
  MAX_PROFILE_INVENTORY_BYTES,
  parseProfileCredentialResult as parseProfileCredentialResultResponse,
  parseProfileMcpServerState as parseProfileMcpServerStateResponse,
  parseProfileMcpServerRemoval as parseProfileMcpServerRemovalResponse,
  parseProfileMemory,
  parseProfileModelState as parseProfileModelStateResponse,
  parseProfileModelBatch,
  parseProfileBundledSkillsState as parseProfileBundledSkillsStateResponse,
  parseProfileSkillState as parseProfileSkillStateResponse,
  parseProfileToolsetState as parseProfileToolsetStateResponse,
  parseProfileToolsetsBatch,
  parseApprovalPolicyState as parseApprovalPolicyStateResponse,
  validBlockedTools,
  PROFILE_MODEL_TOKEN_PATTERN,
  readBoundedJson as readBoundedJsonParser,
} from "../parsers";
import type { HermesClientContext } from "./context";

/**
 * Inventaire des profils Hermes déjà présents sur l'hôte : lecture nommée,
 * jamais persistée. Le profil `default` n'y figure pas. Aucun `.env`,
 * aucune mémoire, aucune session.
 */
export async function hostProfileInventory(ctx: HermesClientContext): Promise<HermesProfileInventory> {
  const response = await ctx.hostRequest(
    "/hermes-setup/profiles",
    { method: "GET" },
    "safe",
    PROFILE_INVENTORY_TIMEOUT_MS,
  );
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseHostProfileInventoryResponse(await readBoundedJsonParser(response, MAX_PROFILE_INVENTORY_BYTES));
}

/**
 * Avatar borné d'un profil nommé. Image seulement ; un slug hors grammaire
 * ou `default` est refusé ici, avant l'aller réseau.
 */
export async function hostProfileAvatar(ctx: HermesClientContext, slug: string): Promise<HermesProfileAvatar> {
  if (!PROFILE_SLUG_PATTERN.test(slug) || slug === "default") {
    throw new HermesClientError("Le slug de profil Hermes est invalide.", 400, "PROFILE_INVALID");
  }
  const response = await ctx.hostRequest(
    `/hermes-setup/profiles/${encodeURIComponent(slug)}/avatar`,
    { method: "GET" },
    "safe",
    PROFILE_AVATAR_TIMEOUT_MS,
  );
  if (!response.ok) await ctx.throwProviderResponse(response);
  const contentType = response.headers.get("content-type") ?? "";
  const bytes = new Uint8Array(await response.arrayBuffer());
  return parseHostProfileAvatarResponse(contentType, bytes);
}

/**
 * `bundledSkills: false` turns the skills shipped with Hermes off in the probe
 * that creates the profile, one interpreter less on a new bot (lab host,
 * 2026-11-02). A host that does not know the field ignores it (non-strict
 * body) and answers without `bundledSkills`: the caller then writes them.
 */
export type HermesHostProfileCreateRequest = HermesHostProfileCreateOptions & { bundledSkills?: false };

/** The created profile and, when asked and proven, its bundled-skills state. */
export type HermesCreatedHostProfileResult = HermesCreatedHostProfile & { bundledSkills?: HermesProfileBundledSkillsState };

export async function hostCreateProfile(
  ctx: HermesClientContext,
  name: string,
  displayNameOrOptions?: string | HermesHostProfileCreateRequest,
): Promise<HermesCreatedHostProfileResult> {
  if (!PROFILE_SLUG_PATTERN.test(name) || name === "default") {
    throw new HermesClientError("Le slug de profil Hermes est invalide.", 400, "PROFILE_INVALID");
  }
  const options = typeof displayNameOrOptions === "string"
    ? { displayName: displayNameOrOptions }
    : (displayNameOrOptions ?? {});
  if (options.displayName !== undefined && (!options.displayName.trim() || options.displayName.length > 120)) {
    throw new HermesClientError("Le nom affiché du profil Hermes est invalide.", 400, "PROFILE_INVALID");
  }
  const provider = options.provider?.trim() || undefined;
  const model = options.model?.trim() || undefined;
  if ((provider === undefined) !== (model === undefined)) {
    throw new HermesClientError("Le fournisseur et le modèle du profil doivent être posés ensemble.", 400, "BODY_INVALID");
  }
  if (provider && (!PROFILE_MODEL_TOKEN_PATTERN.test(provider) || !PROFILE_MODEL_TOKEN_PATTERN.test(model!))) {
    throw new HermesClientError("Le fournisseur ou le modèle du profil Hermes est invalide.", 400, "BODY_INVALID");
  }
  const body: Record<string, string | boolean> = { name };
  if (options.displayName !== undefined) body.displayName = options.displayName;
  if (provider && model) {
    body.provider = provider;
    body.model = model;
  }
  const bundledSkillsOff = "bundledSkills" in options && options.bundledSkills === false;
  if (bundledSkillsOff) body.bundledSkills = false;
  const response = await ctx.hostRequest(
    "/hermes-setup/profiles",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    "mutation",
    PROFILE_MUTATION_TIMEOUT_MS,
  );
  if (!response.ok) await ctx.throwProviderResponse(response);
  const json = await ctx.providerJson(response);
  const created: HermesCreatedHostProfileResult = parseHostProfileCreateResultResponse(json);
  const answered = bundledSkillsOff && json && typeof json === "object" ? (json as Record<string, unknown>).bundledSkills : undefined;
  if (answered !== undefined) {
    // Anything but a coherent state for THIS profile, turned off, is no
    // proof: the caller writes the bundled skills itself.
    try {
      const state = parseProfileBundledSkillsStateResponse(answered);
      if (state.profile === name && state.requested === false) created.bundledSkills = state;
    } catch {
      // Unreadable: left out, as if the host had not answered it.
    }
  }
  return created;
}

/**
 * Écrit `model: {provider, default}` dans le `config.yaml` du profil. Relu
 * sur l'inventaire : sous un profil multiplexé le gateway ignore le
 * `provider` du run et lit ce bloc.
 */
export async function hostSetProfileModel(
  ctx: HermesClientContext,
  profile: string,
  selection: { provider: string; model: string },
): Promise<HermesProfileModelState> {
  if (!PROFILE_SLUG_PATTERN.test(profile) || profile === "default") {
    throw new HermesClientError("Le slug de profil Hermes est invalide.", 400, "PROFILE_INVALID");
  }
  const provider = selection.provider.trim();
  const model = selection.model.trim();
  if (!PROFILE_MODEL_TOKEN_PATTERN.test(provider) || !PROFILE_MODEL_TOKEN_PATTERN.test(model)) {
    throw new HermesClientError("Le fournisseur ou le modèle du profil Hermes est invalide.", 400, "BODY_INVALID");
  }
  const response = await ctx.hostRequest(
    `/hermes-setup/profiles/${encodeURIComponent(profile)}/model`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, model }),
    },
    "mutation",
    PROFILE_MUTATION_TIMEOUT_MS,
  );
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseProfileModelStateResponse(await ctx.providerJson(response), { provider, model });
}

/**
 * Écrit le même `model: {provider, default}` dans plusieurs profils en UN
 * aller-retour hôte (feature `profile_model_batch`) : une écriture, une
 * relecture de l'inventaire, au lieu des deux par profil de `hostSetProfileModel`.
 */
export async function hostSetProfileModels(
  ctx: HermesClientContext,
  profileNames: readonly string[],
  selection: { provider: string; model: string },
): Promise<HermesProfileModelBatchEntry[]> {
  const names = [...new Set(profileNames)];
  if (
    names.length === 0 || names.length > PROFILE_MODEL_BATCH_MAX
    || names.some((name) => !PROFILE_SLUG_PATTERN.test(name) || name === "default")
  ) {
    throw new HermesClientError("La liste de profils Hermes est invalide.", 400, "PROFILE_INVALID");
  }
  const provider = selection.provider.trim();
  const model = selection.model.trim();
  if (!PROFILE_MODEL_TOKEN_PATTERN.test(provider) || !PROFILE_MODEL_TOKEN_PATTERN.test(model)) {
    throw new HermesClientError("Le fournisseur ou le modèle du profil Hermes est invalide.", 400, "BODY_INVALID");
  }
  const response = await ctx.hostRequest(
    "/hermes-setup/profiles/models",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, model, profiles: names }),
    },
    "mutation",
    PROFILE_MUTATION_TIMEOUT_MS,
  );
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseProfileModelBatch(await ctx.providerJson(response), names);
}

export async function hostDeleteProfile(ctx: HermesClientContext, slug: string): Promise<void> {
  if (!PROFILE_SLUG_PATTERN.test(slug) || slug === "default") {
    throw new HermesClientError("Le slug de profil Hermes est invalide.", 400, "PROFILE_INVALID");
  }
  const response = await ctx.hostRequest(
    `/hermes-setup/profiles/${encodeURIComponent(slug)}`,
    { method: "DELETE" },
    "mutation",
    PROFILE_MUTATION_TIMEOUT_MS,
  );
  if (!response.ok) await ctx.throwProviderResponse(response);
  await response.body?.cancel().catch(() => undefined);
}

export async function hostSetProfileToolset(ctx: HermesClientContext, profile: string, name: string, enabled: boolean): Promise<HermesProfileToolsetState> {
  if (!PROFILE_SLUG_PATTERN.test(profile) || profile === "default") {
    throw new HermesClientError("Le slug de profil Hermes est invalide.", 400, "PROFILE_INVALID");
  }
  if (!TOOLSET_KEY_PATTERN.test(name)) {
    throw new HermesClientError("Le nom du toolset Hermes est invalide.", 400, "TOOLSET_INVALID");
  }
  const response = await ctx.hostRequest(
    `/hermes-setup/profiles/${encodeURIComponent(profile)}/toolsets/${encodeURIComponent(name)}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) },
    "mutation",
    PROFILE_MUTATION_TIMEOUT_MS,
  );
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseProfileToolsetStateResponse(await ctx.providerJson(response));
}

/** Twin of `maxProfileToolsetsBatch` (edge-setup/internal/operator/profile_toolsets_batch.go). */
export const PROFILE_TOOLSETS_BATCH_MAX = 32;

/**
 * Plusieurs toolsets d'un profil en une écriture (`profile_toolsets_batch`) :
 * un appel CLI par sens sur l'hôte au lieu d'un par toolset. Rend un état
 * relu par nom, dans l'ordre des noms ; un lot refusé ne change rien.
 */
export async function hostSetProfileToolsets(
  ctx: HermesClientContext,
  profile: string,
  toolsets: Readonly<Record<string, boolean>>,
): Promise<HermesProfileToolsetState[]> {
  if (!PROFILE_SLUG_PATTERN.test(profile) || profile === "default") {
    throw new HermesClientError("Le slug de profil Hermes est invalide.", 400, "PROFILE_INVALID");
  }
  const names = Object.keys(toolsets).sort();
  if (names.length === 0 || names.length > PROFILE_TOOLSETS_BATCH_MAX) {
    throw new HermesClientError("Le lot de toolsets Hermes est vide ou trop long.", 400, "BODY_INVALID");
  }
  if (names.some((name) => !TOOLSET_KEY_PATTERN.test(name) || typeof toolsets[name] !== "boolean")) {
    throw new HermesClientError("Le nom du toolset Hermes est invalide.", 400, "TOOLSET_INVALID");
  }
  const response = await ctx.hostRequest(
    `/hermes-setup/profiles/${encodeURIComponent(profile)}/toolsets`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ toolsets: Object.fromEntries(names.map((name) => [name, toolsets[name]])) }) },
    "mutation",
    PROFILE_MUTATION_TIMEOUT_MS,
  );
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseProfileToolsetsBatch(await ctx.providerJson(response), profile, names);
}

export async function hostApprovalPolicy(ctx: HermesClientContext, slug: string): Promise<HermesApprovalPolicyState> {
  if (!PROFILE_SLUG_PATTERN.test(slug) || slug === "default") throw new HermesClientError("The Hermes profile slug is invalid.", 400, "PROFILE_INVALID");
  const response = await ctx.hostRequest(`/hermes-setup/profiles/${encodeURIComponent(slug)}/approval-policy`, { method: "GET" }, "safe", PROFILE_MUTATION_TIMEOUT_MS);
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseApprovalPolicyStateResponse(await ctx.providerJson(response));
}

/**
 * Writes the profile policy. Without `blockedTools` the host keeps the list
 * it has; with it, the list is replaced and proven by the read-back.
 */
export async function hostSetApprovalPolicy(
  ctx: HermesClientContext,
  slug: string,
  mode: HermesApprovalPolicyMode,
  blockedTools?: readonly string[],
): Promise<HermesApprovalPolicyState> {
  if (!PROFILE_SLUG_PATTERN.test(slug) || slug === "default") throw new HermesClientError("The Hermes profile slug is invalid.", 400, "PROFILE_INVALID");
  if (!["ask_writes", "block_writes", "off"].includes(mode)) throw new HermesClientError("The approval policy mode is invalid.", 400, "BODY_INVALID");
  if (blockedTools && !validBlockedTools(blockedTools)) throw new HermesClientError("The blocked tool list is invalid.", 400, "BODY_INVALID");
  const body = blockedTools ? { mode, blockedTools } : { mode };
  const response = await ctx.hostRequest(`/hermes-setup/profiles/${encodeURIComponent(slug)}/approval-policy`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, "mutation", PROFILE_MUTATION_TIMEOUT_MS);
  if (!response.ok) await ctx.throwProviderResponse(response);
  const state = parseApprovalPolicyStateResponse(await ctx.providerJson(response));
  const blockedProven = !blockedTools || (state.blockedTools !== null && state.blockedTools.length === blockedTools.length && state.blockedTools.every((key, index) => key === blockedTools[index]));
  if (state.mode !== mode || !state.pluginEnabled || !blockedProven) throw new HermesClientError("The approval policy write could not be verified.", 502, "APPROVAL_POLICY_UNVERIFIED");
  return state;
}

/**
 * La mémoire d'un profil nommé (`MEMORY.md` / `USER.md`), lue par le
 * magasin amont sur l'hôte. Lecture seule ; les fichiers ne traversent pas.
 */
export async function hostProfileMemory(ctx: HermesClientContext, profile: string): Promise<HermesProfileMemory> {
  if (!PROFILE_SLUG_PATTERN.test(profile) || profile === "default") {
    throw new HermesClientError("Le slug de profil Hermes est invalide.", 400, "PROFILE_INVALID");
  }
  const response = await ctx.hostRequest(
    `/hermes-setup/profiles/${encodeURIComponent(profile)}/memory`,
    { method: "GET" },
    "safe",
    PROFILE_INVENTORY_TIMEOUT_MS,
  );
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseProfileMemory(await ctx.providerJson(response));
}

/**
 * Une écriture nommée (add / replace / remove) sur cette mémoire, par le
 * magasin amont : mêmes plafonds, même format, même dédoublonnage que
 * l'outil `memory` du bot. Le résultat est le magasin relu.
 */
export async function hostWriteProfileMemory(ctx: HermesClientContext, profile: string, write: HermesProfileMemoryWrite): Promise<HermesProfileMemory> {
  if (!PROFILE_SLUG_PATTERN.test(profile) || profile === "default") {
    throw new HermesClientError("Le slug de profil Hermes est invalide.", 400, "PROFILE_INVALID");
  }
  const body = {
    target: write.target,
    action: write.action,
    content: "content" in write ? write.content : "",
    oldText: "oldText" in write ? write.oldText : "",
  };
  const response = await ctx.hostRequest(
    `/hermes-setup/profiles/${encodeURIComponent(profile)}/memory`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    "mutation",
    PROFILE_MUTATION_TIMEOUT_MS,
  );
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseProfileMemory(await ctx.providerJson(response));
}

export async function hostSetProfileMcpServer(ctx: HermesClientContext, profile: string, name: string, enabled: boolean): Promise<HermesProfileMcpServerState> {
  if (!PROFILE_SLUG_PATTERN.test(profile) || profile === "default") {
    throw new HermesClientError("Le slug de profil Hermes est invalide.", 400, "PROFILE_INVALID");
  }
  if (!MCP_NAME_PATTERN.test(name)) {
    throw new HermesClientError("Le nom du serveur MCP est invalide.", 400, "NAME_INVALID");
  }
  const response = await ctx.hostRequest(
    `/hermes-setup/profiles/${encodeURIComponent(profile)}/mcp/servers/${encodeURIComponent(name)}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) },
    "mutation",
    PROFILE_MUTATION_TIMEOUT_MS,
  );
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseProfileMcpServerStateResponse(await ctx.providerJson(response));
}

/**
 * Déconnecte un serveur MCP d'un profil nommé (feature `mcp_profile_disconnect`) :
 * l'entrée du profil et son jeton OAuth partent, la racine et les autres
 * profils ne changent pas.
 */
export async function hostRemoveProfileMcpServer(ctx: HermesClientContext, profile: string, name: string): Promise<HermesProfileMcpServerRemoval> {
  if (!PROFILE_SLUG_PATTERN.test(profile) || profile === "default") {
    throw new HermesClientError("Le slug de profil Hermes est invalide.", 400, "PROFILE_INVALID");
  }
  if (!MCP_NAME_PATTERN.test(name)) {
    throw new HermesClientError("Le nom du serveur MCP est invalide.", 400, "NAME_INVALID");
  }
  const response = await ctx.hostRequest(
    `/hermes-setup/profiles/${encodeURIComponent(profile)}/mcp/servers/${encodeURIComponent(name)}`,
    { method: "DELETE" },
    "mutation",
    PROFILE_MUTATION_TIMEOUT_MS,
  );
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseProfileMcpServerRemovalResponse(await ctx.providerJson(response));
}

export async function hostSetProfileSkill(ctx: HermesClientContext, profile: string, name: string, enabled: boolean): Promise<HermesProfileSkillState> {
  if (!PROFILE_SLUG_PATTERN.test(profile) || profile === "default") {
    throw new HermesClientError("Le slug de profil Hermes est invalide.", 400, "PROFILE_INVALID");
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new HermesClientError("Le nom de la skill Hermes est invalide.", 400, "SKILL_INVALID");
  }
  const response = await ctx.hostRequest(
    `/hermes-setup/profiles/${encodeURIComponent(profile)}/skills/${encodeURIComponent(name)}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) },
    "mutation",
    PROFILE_MUTATION_TIMEOUT_MS,
  );
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseProfileSkillStateResponse(await ctx.providerJson(response));
}

/**
 * Éteint (ou rétablit) en bloc les skills livrées avec Hermes dans un profil
 * nommé. Les skills apprises et celles de la Marketplace restent intactes.
 * `applied` est l'avis de l'hôte, relu après l'écriture.
 */
export async function hostSetProfileBundledSkills(ctx: HermesClientContext, profile: string, enabled: boolean): Promise<HermesProfileBundledSkillsState> {
  if (!PROFILE_SLUG_PATTERN.test(profile) || profile === "default") {
    throw new HermesClientError("Le slug de profil Hermes est invalide.", 400, "PROFILE_INVALID");
  }
  const response = await ctx.hostRequest(
    `/hermes-setup/profiles/${encodeURIComponent(profile)}/bundled-skills`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) },
    "mutation",
    PROFILE_MUTATION_TIMEOUT_MS,
  );
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseProfileBundledSkillsStateResponse(await ctx.providerJson(response));
}

/**
 * Pose une clé fournisseur propre à un profil nommé. La clé voyage dans le
 * corps JSON jusqu'à l'hôte, puis au stdin de la sonde : elle n'apparaît
 * ni dans le chemin, ni dans un journal, ni dans la réponse. Le verdict
 * est relu sur `/p/<slug>/api/model/options`.
 */
export async function hostSetProfileCredential(ctx: HermesClientContext, profile: string, provider: string, apiKey: string, label?: string): Promise<HermesProfileCredentialResult> {
  if (!PROFILE_SLUG_PATTERN.test(profile) || profile === "default") {
    throw new HermesClientError("Le slug de profil Hermes est invalide.", 400, "PROFILE_INVALID");
  }
  if (!PROVIDER_SLUG_PATTERN.test(provider)) {
    throw new HermesClientError("Le slug du fournisseur Hermes est invalide.", 400, "PROVIDER_INVALID");
  }
  if (!apiKey || apiKey.length > 4_000 || /[\u0000-\u001F\u007F]/u.test(apiKey)) {
    throw new HermesClientError("La clé fournisseur est invalide.", 400, "API_KEY_INVALID");
  }
  const response = await ctx.hostRequest(
    `/hermes-setup/profiles/${encodeURIComponent(profile)}/providers/${encodeURIComponent(provider)}/credentials`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(label === undefined ? { apiKey } : { apiKey, label }),
    },
    "mutation",
    PROVIDER_MUTATION_TIMEOUT_MS,
  );
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseProfileCredentialResultResponse(await ctx.providerJson(response));
}

export async function hostDeleteProfileCredential(ctx: HermesClientContext, profile: string, provider: string): Promise<HermesProfileCredentialResult> {
  if (!PROFILE_SLUG_PATTERN.test(profile) || profile === "default") {
    throw new HermesClientError("Le slug de profil Hermes est invalide.", 400, "PROFILE_INVALID");
  }
  if (!PROVIDER_SLUG_PATTERN.test(provider)) {
    throw new HermesClientError("Le slug du fournisseur Hermes est invalide.", 400, "PROVIDER_INVALID");
  }
  const response = await ctx.hostRequest(
    `/hermes-setup/profiles/${encodeURIComponent(profile)}/providers/${encodeURIComponent(provider)}/credentials`,
    { method: "DELETE" },
    "mutation",
    PROVIDER_MUTATION_TIMEOUT_MS,
  );
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseProfileCredentialResultResponse(await ctx.providerJson(response));
}
