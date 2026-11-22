/** The skills hub contracts of a Hermes host: search, inspection, scan, install operations. */
export const SKILLS_HUB_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/;
export const SKILLS_HUB_PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const SKILLS_HUB_OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type HermesSkillsHubTrustLevel = "official" | "trusted" | "builtin" | "community";
export type HermesSkillsHubSearchResult = {
  name: string;
  identifier: string;
  source: string;
  trustLevel: HermesSkillsHubTrustLevel;
  description: string;
};

export type HermesSkillsHubInspection = {
  name: string;
  description: string;
  source: string;
  identifier: string;
  tags: string[];
  skillMdPreview: string | null;
};

export type HermesSkillsHubFinding = {
  severity: "critical" | "high" | "medium" | "low";
  category: string;
  description: string;
  file: string | null;
  line: number | null;
};

export type HermesSkillsHubScan = {
  trustLevel: HermesSkillsHubTrustLevel;
  source: string;
  verdict: "safe" | "caution" | "dangerous";
  policy: "allow" | "ask" | "block";
  findings: HermesSkillsHubFinding[];
};

export type HermesSkillsHubOperationState = "queued" | "running" | "succeeded" | "failed";
export type HermesSkillsHubOperationError = { code: string; detail: string };
export type HermesSkillsHubOperation = {
  operationId: string;
  profile: string;
  identifier: string;
  state: HermesSkillsHubOperationState;
  error: HermesSkillsHubOperationError | null;
  skills: string[] | null;
};

export type HermesProfileSkillsHubDelete = {
  profile: string;
  skill: string;
  skills: string[];
};
