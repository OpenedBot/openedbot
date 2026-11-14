/**
 * What the seed hands to the driver: one access token per connected session,
 * the organization it belongs to and the threads it may post in. The file is
 * written once by `seed.ts`, read once by `bench.ts`, and lives in the run's
 * temporary directory only (tokens are secrets: never under the repository).
 */
export type LoadSession = {
  accessToken: string;
  organizationId: string;
  threadIds: string[];
};

export type LoadManifest = {
  organizations: number;
  sessions: LoadSession[];
};

export const LOAD_TIERS = [50, 100, 200, 500] as const;

export type LoadTier = (typeof LOAD_TIERS)[number];

export function readTier(value: string | undefined): LoadTier {
  const tier = Number(value ?? 200);
  if (!LOAD_TIERS.includes(tier as LoadTier)) throw new Error(`LOAD_SESSIONS must be one of ${LOAD_TIERS.join(", ")}.`);
  return tier as LoadTier;
}

export async function readManifest(path: string, tier: LoadTier): Promise<LoadManifest> {
  const manifest = JSON.parse(await Bun.file(path).text()) as LoadManifest;
  if (!Array.isArray(manifest.sessions) || manifest.sessions.length < tier) {
    throw new Error(`Load manifest holds ${manifest.sessions?.length ?? 0}/${tier} sessions.`);
  }
  return { organizations: manifest.organizations, sessions: manifest.sessions.slice(0, tier) };
}
