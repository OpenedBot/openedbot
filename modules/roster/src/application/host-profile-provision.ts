import { HermesClientError, type HermesClient, type HermesClientConfig, type HermesHostProfileCreateOptions } from "@openedbot/hermes";
import { ProfileImportError } from "../domain/profile-errors";
import { applyHostProfileModel } from "./host-profile-model";

export type ProfileProvisionClient = Pick<HermesClient, "hostCreateProfile" | "hostDeleteProfile" | "probeProfileIsolation" | "hostSetProfileModel">;

export function profileCreationFailureState(error: unknown): "created" | "not_created" | "unknown" {
  if (error instanceof HermesClientError) {
    if (error.code === "PROFILE_UNVERIFIED") return "created";
    if (error.requestDelivery === "not_sent" || ["PROFILE_EXISTS", "PROFILE_INVALID", "BODY_INVALID", "MULTIPLEX_OFF"].includes(error.code)) return "not_created";
  }
  return "unknown";
}

/** Used by synchronous bot creation. Compensation is limited to confirmed creation. */
export async function createManagedProfile(
  runtime: { client: HermesClientConfig }, slug: string, displayName: string,
  clientFactory: (config: HermesClientConfig) => ProfileProvisionClient,
  selection?: HermesHostProfileCreateOptions,
): Promise<{ applied: boolean }> {
  const client = clientFactory(runtime.client);
  let created = false;
  try {
    let result;
    try {
      result = await client.hostCreateProfile(slug, { displayName, ...(selection?.provider && selection.model ? { provider: selection.provider, model: selection.model } : {}) });
      created = true;
    } catch (error) {
      const state = profileCreationFailureState(error);
      created = state === "created";
      if (state === "unknown") throw profileProvisionError(error, [slug]);
      throw error;
    }
    if (await clientFactory({ ...runtime.client, profile: slug }).probeProfileIsolation(slug) !== "isolated") {
      throw new Error("profile_isolation_not_proven");
    }
    if (!selection?.provider || !selection.model) return { applied: false };
    if (result.model.provider === selection.provider && result.model.default === selection.model) return { applied: true };
    return applyHostProfileModel(client, slug, { provider: selection.provider, model: selection.model });
  } catch (error) {
    const unconfirmed: string[] = [];
    if (created) {
      try { await client.hostDeleteProfile(slug); }
      catch { unconfirmed.push(slug); }
    }
    if (error instanceof ProfileImportError && !unconfirmed.length) throw error;
    throw profileProvisionError(error, unconfirmed);
  }
}

export function profileProvisionError(error: unknown, unconfirmed: string[] = []): ProfileImportError {
  if (error instanceof HermesClientError && error.code === "PROFILE_EXISTS") {
    return new ProfileImportError(409, "HERMES_PROFILE_EXISTS", "Un profil Hermes portant ce nom existe déjà. Utilisez l’import depuis le runtime.");
  }
  return new ProfileImportError(502, "HERMES_PROFILE_CREATE_FAILED", "Le profil Hermes n’a pas pu être créé et vérifié.", unconfirmed.length ? { unconfirmedProfiles: unconfirmed } : undefined);
}
