import { isRecord } from "@openedbot/contracts-primitives";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Frontière d'import du format BotMRR Markdown actuel d'OpenMausBot.
 *
 * Le frontmatter est la source structurée. Le corps Markdown reste lisible par
 * un humain, mais ne peut ni accorder un droit, ni sélectionner un runtime, ni
 * transporter un secret. Les anciens documents qui ne portent que `## Team`
 * restent acceptés comme import de bots uniquement.
 */
const TEAM_MARKDOWN_FORMAT = "openmaus.botmrr" as const;
const TEAM_MARKDOWN_VERSION = 1 as const;
const TEAM_MARKDOWN_MAX_BYTES = 1_000_000;
export const TEAM_MARKDOWN_MAX_MEMBERS = 200;
export const TEAM_MARKDOWN_MAX_ROOMS = 30;
export const TEAM_MARKDOWN_MAX_ROUTINES = 50;
const TEAM_MARKDOWN_MAX_PLAYBOOKS = 80;
const TEAM_MARKDOWN_MAX_CONNECTIONS = 30;

const MAX_TEAM_NAME = 100;
const MAX_MEMBER_NAME = 100;
const MAX_ROLE = 200;
const MAX_INSTRUCTIONS = 4_000;
const MAX_ROOM_INSTRUCTIONS = 12_000;
const MAX_PLAYBOOK_INSTRUCTIONS = 24_000;
const MAX_ROUTINE_PROMPT = 20_000;
const MEMBER_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PACKAGE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const DAILY_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export type TeamMarkdownMember = {
  key: string;
  name: string;
  /** Libellé humain uniquement ; ne confère aucune permission. */
  role: string;
  /** Texte explicite du bloc membre, conservé comme Markdown. */
  instructions: string;
  /** Références validées vers les playbooks du même document. */
  playbooks: string[];
};

export type TeamMarkdownPlaybook = {
  key: string;
  name: string;
  summary: string;
  triggers: string[];
  instructions: string;
};

export type TeamMarkdownRoom = {
  key: string;
  name: string;
  members: string[];
  /** `bulletin` OpenMausBot, injecté comme instructions communes du salon. */
  instructions: string;
  defaultResponder:
    | { kind: "member"; member: string }
    | { kind: "everyone" }
    | { kind: "mentions" };
};

export type TeamMarkdownRoutine = {
  key: string;
  name: string;
  agent: string;
  prompt: string;
  runOn: "maus" | "cloud";
  schedule: {
    type: "daily";
    time: string;
    /** 0 = dimanche, comme le format OpenMausBot et cron. */
    weekdays: number[];
  };
  durationMinutes: number;
  /** État déclaré par le package. L'installation openedbot reste volontairement en pause. */
  enabledAfterInstall?: boolean;
};

export type TeamMarkdownExportInput = Omit<ParsedTeamMarkdown, "sourceId" | "release"> & {
  sourceId: string;
  release: string;
  /** Limites qui doivent voyager avec le fichier partagé, pas seulement avec l'UI. */
  limitations?: readonly string[];
};

export type TeamMarkdownConnection = {
  slug: string;
  label: string;
  reason: string;
  optional: boolean;
};

export type ParsedTeamMarkdown = {
  format: typeof TEAM_MARKDOWN_FORMAT;
  version: typeof TEAM_MARKDOWN_VERSION;
  name: string;
  /** Présents dans les packages BotMRR actuels ; absents sur le legacy. */
  sourceId: string | null;
  release: string | null;
  members: TeamMarkdownMember[];
  chiefOfStaff: string;
  rooms: TeamMarkdownRoom[];
  routines: TeamMarkdownRoutine[];
  playbooks: TeamMarkdownPlaybook[];
  connections: TeamMarkdownConnection[];
};

export type TeamMarkdownIssueCode =
  | "document_too_large"
  | "frontmatter_missing"
  | "frontmatter_invalid"
  | "version_missing"
  | "version_unsupported"
  | "team_name_missing"
  | "team_name_too_long"
  | "team_section_missing"
  | "team_section_ambiguous"
  | "package_id_invalid"
  | "package_release_invalid"
  | "member_header_invalid"
  | "member_name_too_long"
  | "member_role_too_long"
  | "member_key_missing"
  | "member_key_ambiguous"
  | "member_key_invalid"
  | "member_key_duplicate"
  | "member_name_duplicate"
  | "member_instructions_missing"
  | "member_instructions_too_long"
  | "member_playbooks_invalid"
  | "member_playbook_unknown"
  | "members_empty"
  | "members_too_many"
  | "chief_unknown"
  | "rooms_invalid"
  | "room_invalid"
  | "room_key_duplicate"
  | "room_member_unknown"
  | "room_member_duplicate"
  | "room_members_unsupported"
  | "room_responder_unknown"
  | "room_instructions_too_long"
  | "playbooks_invalid"
  | "playbook_invalid"
  | "playbook_key_duplicate"
  | "routines_invalid"
  | "routine_invalid"
  | "routine_key_duplicate"
  | "routine_agent_unknown"
  | "routine_schedule_unsupported"
  | "connections_invalid"
  | "connection_invalid"
  | "connection_key_duplicate";

export type TeamMarkdownIssue = {
  code: TeamMarkdownIssueCode;
  message: string;
  /** Ligne 1-based dans le document, quand l'erreur est localisable. */
  line?: number;
  /** Chemin stable utilisable par l'API et les clients. */
  path: string;
};

export type TeamMarkdownValidation =
  | { ok: true; value: ParsedTeamMarkdown; issues: [] }
  | { ok: false; value: null; issues: TeamMarkdownIssue[] };

class TeamMarkdownError extends Error {
  readonly issues: TeamMarkdownIssue[];

  constructor(issues: TeamMarkdownIssue[]) {
    super(issues[0]?.message ?? "Invalid Team Markdown");
    this.name = "TeamMarkdownError";
    this.issues = issues;
  }
}

type SourceLine = { text: string; number: number };
type UnknownRecord = Record<string, unknown>;

function issue(code: TeamMarkdownIssueCode, message: string, path: string, line?: number): TeamMarkdownIssue {
  return line === undefined ? { code, message, path } : { code, message, path, line };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function normalizedIdentity(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function requiredText(
  value: unknown,
  max: number,
  code: TeamMarkdownIssueCode,
  label: string,
  path: string,
  issues: TeamMarkdownIssue[],
  tooLongCode: TeamMarkdownIssueCode = code,
): string {
  if (typeof value !== "string" || !value.trim()) {
    issues.push(issue(code, `${label} is required`, path));
    return "";
  }
  const text = value.trim();
  if (text.length > max) issues.push(issue(tooLongCode, `${label} is too long`, path));
  return text;
}

function readKey(value: unknown, code: TeamMarkdownIssueCode, path: string, issues: TeamMarkdownIssue[]): string {
  const key = typeof value === "string" ? value.trim() : "";
  if (!MEMBER_KEY.test(key)) issues.push(issue(code, "Key must use lowercase letters, numbers, - or _", path));
  return key;
}

/** Valide un document non fiable sans lever d'exception. */
export function validateTeamMarkdown(input: unknown): TeamMarkdownValidation {
  if (typeof input !== "string") {
    return { ok: false, value: null, issues: [issue("frontmatter_missing", "Team Markdown must be text", "document")] };
  }
  const source = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (byteLength(source) > TEAM_MARKDOWN_MAX_BYTES) {
    return { ok: false, value: null, issues: [issue("document_too_large", "Team Markdown exceeds 1,000,000 bytes", "document")] };
  }

  const lines: SourceLine[] = source.split("\n").map((text, index) => ({ text, number: index + 1 }));
  if (lines[0]?.text !== "---") {
    return { ok: false, value: null, issues: [issue("frontmatter_missing", "Team Markdown is missing YAML frontmatter", "document", 1)] };
  }
  const frontmatterEnd = lines.findIndex((line, index) => index > 0 && line.text === "---");
  if (frontmatterEnd < 0) {
    return { ok: false, value: null, issues: [issue("frontmatter_missing", "Team Markdown frontmatter is not closed", "document", 1)] };
  }

  let metadata: UnknownRecord;
  try {
    const parsed = parseYaml(lines.slice(1, frontmatterEnd).map((line) => line.text).join("\n"), { maxAliasCount: 50 });
    if (!isRecord(parsed)) throw new Error("frontmatter must be an object");
    metadata = parsed;
  } catch {
    return { ok: false, value: null, issues: [issue("frontmatter_invalid", "Team Markdown contains invalid YAML frontmatter", "document", 1)] };
  }
  if (!("botmrr" in metadata)) {
    return { ok: false, value: null, issues: [issue("version_missing", "Team Markdown is missing botmrr: 1", "document", 1)] };
  }
  if (metadata.botmrr !== TEAM_MARKDOWN_VERSION) {
    return { ok: false, value: null, issues: [issue("version_unsupported", "BotMRR Markdown version is not supported", "document", 2)] };
  }
  return Array.isArray(metadata.agents)
    ? validateCurrentPackage(lines, frontmatterEnd, metadata)
    : validateLegacyTeam(lines, frontmatterEnd);
}

function validateCurrentPackage(lines: SourceLine[], frontmatterEnd: number, metadata: UnknownRecord): TeamMarkdownValidation {
  const issues: TeamMarkdownIssue[] = [];
  const body = lines.slice(frontmatterEnd + 1);
  const bodyName = body.find((line) => /^# (?!#)/.test(line.text))?.text.slice(2).trim() ?? "";
  const name = requiredText(metadata.name ?? bodyName, MAX_TEAM_NAME, "team_name_missing", "Team name", "name", issues, "team_name_too_long");
  const sourceId = typeof metadata.id === "string" ? metadata.id.trim() : "";
  if (!PACKAGE_ID.test(sourceId)) issues.push(issue("package_id_invalid", "Package id must be a lowercase slug", "sourceId"));
  const release = typeof metadata.release === "string" ? metadata.release.trim() : "";
  if (!SEMVER.test(release)) issues.push(issue("package_release_invalid", "Package release must use semantic versioning", "release"));

  const playbooks = readPlaybooks(metadata.playbooks, issues);
  const playbookKeys = new Set(playbooks.map((entry) => entry.key));
  const members = readCurrentMembers(metadata.agents, playbookKeys, issues);
  const memberKeys = new Set(members.map((entry) => entry.key));
  const chiefOfStaff = typeof metadata.chiefOfStaff === "string" && metadata.chiefOfStaff.trim()
    ? metadata.chiefOfStaff.trim()
    : members[0]?.key ?? "";
  if (!memberKeys.has(chiefOfStaff)) issues.push(issue("chief_unknown", `Unknown Chief of Staff: ${chiefOfStaff}`, "chiefOfStaff"));
  const rooms = readRooms(metadata.rooms, memberKeys, issues);
  const routines = readRoutines(metadata.routines, memberKeys, issues);
  const connections = readConnections(metadata.requirements, issues);

  const teamHeadings = body.filter((line) => line.text.trim() === "## Team");
  if (teamHeadings.length === 0) issues.push(issue("team_section_missing", "Team Markdown is missing its ## Team section", "members"));
  else if (teamHeadings.length > 1) issues.push(issue("team_section_ambiguous", "Team Markdown contains more than one ## Team section", "members", teamHeadings[1]!.number));
  if (issues.length) return { ok: false, value: null, issues };
  return {
    ok: true,
    issues: [],
    value: { format: TEAM_MARKDOWN_FORMAT, version: TEAM_MARKDOWN_VERSION, name, sourceId, release, members, chiefOfStaff, rooms, routines, playbooks, connections },
  };
}

function readCurrentMembers(value: unknown, playbookKeys: ReadonlySet<string>, issues: TeamMarkdownIssue[]): TeamMarkdownMember[] {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(issue("members_empty", "Team Markdown needs at least one member", "members"));
    return [];
  }
  if (value.length > TEAM_MARKDOWN_MAX_MEMBERS) issues.push(issue("members_too_many", `Team Markdown supports at most ${TEAM_MARKDOWN_MAX_MEMBERS} members`, "members"));
  const result: TeamMarkdownMember[] = [];
  const keys = new Set<string>();
  const names = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const path = `members.${index}`;
    if (!isRecord(raw)) {
      issues.push(issue("member_header_invalid", "Member must be an object", path));
      continue;
    }
    const key = readKey(raw.key, "member_key_invalid", `${path}.key`, issues);
    if (keys.has(key)) issues.push(issue("member_key_duplicate", `Duplicate member key: ${key}`, `${path}.key`));
    keys.add(key);
    const name = requiredText(raw.name, MAX_MEMBER_NAME, "member_name_too_long", "Member name", `${path}.name`, issues);
    const normalizedName = normalizedIdentity(name);
    if (names.has(normalizedName)) issues.push(issue("member_name_duplicate", `Duplicate member name: ${name}`, `${path}.name`));
    names.add(normalizedName);
    const role = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "Specialist";
    if (role.length > MAX_ROLE) issues.push(issue("member_role_too_long", "Member role is too long", `${path}.role`));
    const instructions = requiredText(raw.description, MAX_INSTRUCTIONS, "member_instructions_missing", "Member instructions", `${path}.instructions`, issues, "member_instructions_too_long");
    const assigned = raw.playbooks === undefined ? [] : raw.playbooks;
    if (!Array.isArray(assigned) || assigned.some((entry) => typeof entry !== "string" || !MEMBER_KEY.test(entry))) {
      issues.push(issue("member_playbooks_invalid", "Member playbooks must be valid keys", `${path}.playbooks`));
    }
    const playbooks = Array.isArray(assigned) ? assigned.filter((entry): entry is string => typeof entry === "string" && MEMBER_KEY.test(entry)) : [];
    if (new Set(playbooks).size !== playbooks.length) issues.push(issue("member_playbooks_invalid", "Member playbooks must be distinct", `${path}.playbooks`));
    for (const playbook of playbooks) {
      if (!playbookKeys.has(playbook)) issues.push(issue("member_playbook_unknown", `Member ${key} references unknown playbook: ${playbook}`, `${path}.playbooks`));
    }
    result.push({ key, name, role, instructions, playbooks });
  }
  return result;
}

function readPlaybooks(value: unknown, issues: TeamMarkdownIssue[]): TeamMarkdownPlaybook[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > TEAM_MARKDOWN_MAX_PLAYBOOKS) {
    issues.push(issue("playbooks_invalid", `Playbooks must be an array of at most ${TEAM_MARKDOWN_MAX_PLAYBOOKS} entries`, "playbooks"));
    return [];
  }
  const result: TeamMarkdownPlaybook[] = [];
  const keys = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const path = `playbooks.${index}`;
    if (!isRecord(raw)) {
      issues.push(issue("playbook_invalid", "Playbook must be an object", path));
      continue;
    }
    const key = readKey(raw.key, "playbook_invalid", `${path}.key`, issues);
    if (keys.has(key)) issues.push(issue("playbook_key_duplicate", `Duplicate playbook key: ${key}`, `${path}.key`));
    keys.add(key);
    const name = requiredText(raw.name, 100, "playbook_invalid", "Playbook name", `${path}.name`, issues);
    const summary = requiredText(raw.summary, 300, "playbook_invalid", "Playbook summary", `${path}.summary`, issues);
    const instructions = requiredText(raw.instructions, MAX_PLAYBOOK_INSTRUCTIONS, "playbook_invalid", "Playbook instructions", `${path}.instructions`, issues);
    if (!Array.isArray(raw.triggers) || raw.triggers.length < 1 || raw.triggers.length > 30 || raw.triggers.some((entry) => typeof entry !== "string" || !entry.trim() || entry.trim().length > 100)) {
      issues.push(issue("playbook_invalid", "Playbook triggers must contain 1 to 30 short labels", `${path}.triggers`));
    }
    const triggers = Array.isArray(raw.triggers) ? raw.triggers.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())).map((entry) => entry.trim()) : [];
    result.push({ key, name, summary, triggers, instructions });
  }
  return result;
}

function readRooms(value: unknown, memberKeys: ReadonlySet<string>, issues: TeamMarkdownIssue[]): TeamMarkdownRoom[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > TEAM_MARKDOWN_MAX_ROOMS) {
    issues.push(issue("rooms_invalid", `Rooms must be an array of at most ${TEAM_MARKDOWN_MAX_ROOMS} entries`, "rooms"));
    return [];
  }
  const result: TeamMarkdownRoom[] = [];
  const keys = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const path = `rooms.${index}`;
    if (!isRecord(raw)) {
      issues.push(issue("room_invalid", "Room must be an object", path));
      continue;
    }
    const key = readKey(raw.key, "room_invalid", `${path}.key`, issues);
    if (keys.has(key)) issues.push(issue("room_key_duplicate", `Duplicate room key: ${key}`, `${path}.key`));
    keys.add(key);
    const name = requiredText(raw.name, 100, "room_invalid", "Room name", `${path}.name`, issues);
    if (!Array.isArray(raw.members) || raw.members.length < 2 || raw.members.length > 6 || raw.members.some((entry) => typeof entry !== "string")) {
      issues.push(issue("room_members_unsupported", "openedbot rooms require 2 to 6 member keys", `${path}.members`));
    }
    const members = Array.isArray(raw.members) ? raw.members.filter((entry): entry is string => typeof entry === "string") : [];
    if (new Set(members).size !== members.length) issues.push(issue("room_member_duplicate", "Room members must be distinct", `${path}.members`));
    for (const member of members) if (!memberKeys.has(member)) issues.push(issue("room_member_unknown", `Room ${key} references unknown member: ${member}`, `${path}.members`));
    const instructions = typeof raw.bulletin === "string" ? raw.bulletin.trim() : "";
    if (instructions.length > MAX_ROOM_INSTRUCTIONS) issues.push(issue("room_instructions_too_long", "Room instructions are too long", `${path}.instructions`));
    const responder = raw.defaultResponder;
    let defaultResponder: TeamMarkdownRoom["defaultResponder"] = { kind: "everyone" };
    if (!isRecord(responder) || !["agent", "everyone", "mentions"].includes(String(responder.kind))) {
      issues.push(issue("room_invalid", "Room default responder is invalid", `${path}.defaultResponder`));
    } else if (responder.kind === "agent") {
      const member = typeof responder.agent === "string" ? responder.agent : "";
      if (!members.includes(member)) issues.push(issue("room_responder_unknown", `Room ${key} has an unknown default responder`, `${path}.defaultResponder`));
      defaultResponder = { kind: "member", member };
    } else {
      defaultResponder = { kind: responder.kind as "everyone" | "mentions" };
    }
    result.push({ key, name, members, instructions, defaultResponder });
  }
  return result;
}

function readRoutines(value: unknown, memberKeys: ReadonlySet<string>, issues: TeamMarkdownIssue[]): TeamMarkdownRoutine[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > TEAM_MARKDOWN_MAX_ROUTINES) {
    issues.push(issue("routines_invalid", `Routines must be an array of at most ${TEAM_MARKDOWN_MAX_ROUTINES} entries`, "routines"));
    return [];
  }
  const result: TeamMarkdownRoutine[] = [];
  const keys = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const path = `routines.${index}`;
    if (!isRecord(raw)) {
      issues.push(issue("routine_invalid", "Routine must be an object", path));
      continue;
    }
    const key = readKey(raw.key, "routine_invalid", `${path}.key`, issues);
    if (keys.has(key)) issues.push(issue("routine_key_duplicate", `Duplicate routine key: ${key}`, `${path}.key`));
    keys.add(key);
    const name = requiredText(raw.name, 80, "routine_invalid", "Routine name", `${path}.name`, issues);
    const agent = typeof raw.agent === "string" ? raw.agent : "";
    if (!memberKeys.has(agent)) issues.push(issue("routine_agent_unknown", `Routine ${key} references unknown member: ${agent}`, `${path}.agent`));
    const prompt = requiredText(raw.prompt, MAX_ROUTINE_PROMPT, "routine_invalid", "Routine prompt", `${path}.prompt`, issues);
    const runOn = raw.runOn === "maus" || raw.runOn === "cloud" ? raw.runOn : "cloud";
    if (raw.runOn !== "maus" && raw.runOn !== "cloud") issues.push(issue("routine_invalid", "Routine runOn must be maus or cloud", `${path}.runOn`));
    const durationMinutes = typeof raw.durationMinutes === "number" && Number.isInteger(raw.durationMinutes) ? raw.durationMinutes : 0;
    if (durationMinutes < 15 || durationMinutes > 240) issues.push(issue("routine_invalid", "Routine duration must be between 15 and 240 minutes", `${path}.durationMinutes`));
    if (!isRecord(raw.schedule) || raw.schedule.type !== "daily") {
      issues.push(issue("routine_schedule_unsupported", "Only daily BotMRR routines can be installed safely; one-time schedules are not supported yet", `${path}.schedule`));
      continue;
    }
    const time = typeof raw.schedule.time === "string" ? raw.schedule.time : "";
    const weekdays = Array.isArray(raw.schedule.weekdays) ? raw.schedule.weekdays.filter((entry): entry is number => typeof entry === "number" && Number.isInteger(entry)) : [];
    if (!DAILY_TIME.test(time) || weekdays.length < 1 || weekdays.length > 7 || weekdays.some((entry) => entry < 0 || entry > 6) || new Set(weekdays).size !== weekdays.length) {
      issues.push(issue("routine_invalid", "Daily routine needs HH:MM and distinct weekdays from 0 to 6", `${path}.schedule`));
    }
    result.push({
      key,
      name,
      agent,
      prompt,
      runOn,
      schedule: { type: "daily", time, weekdays },
      durationMinutes,
      enabledAfterInstall: raw.enabledAfterInstall === true,
    });
  }
  return result;
}

function readConnections(value: unknown, issues: TeamMarkdownIssue[]): TeamMarkdownConnection[] {
  if (value === undefined) return [];
  if (!isRecord(value) || !Array.isArray(value.apps) || value.apps.length > TEAM_MARKDOWN_MAX_CONNECTIONS) {
    issues.push(issue("connections_invalid", `requirements.apps must contain at most ${TEAM_MARKDOWN_MAX_CONNECTIONS} entries`, "connections"));
    return [];
  }
  const result: TeamMarkdownConnection[] = [];
  const keys = new Set<string>();
  for (const [index, raw] of value.apps.entries()) {
    const path = `connections.${index}`;
    if (!isRecord(raw)) {
      issues.push(issue("connection_invalid", "Connection must be an object", path));
      continue;
    }
    const slug = readKey(raw.slug, "connection_invalid", `${path}.slug`, issues);
    if (keys.has(slug)) issues.push(issue("connection_key_duplicate", `Duplicate connection slug: ${slug}`, `${path}.slug`));
    keys.add(slug);
    const label = requiredText(raw.label, 100, "connection_invalid", "Connection label", `${path}.label`, issues);
    const reason = requiredText(raw.reason, 240, "connection_invalid", "Connection reason", `${path}.reason`, issues);
    result.push({ slug, label, reason, optional: raw.optional === true });
  }
  return result;
}

/** Ancien contrat bot-only, conservé pour les exports déjà partagés. */
function validateLegacyTeam(lines: SourceLine[], frontmatterEnd: number): TeamMarkdownValidation {
  const body = lines.slice(frontmatterEnd + 1);
  const titles = body.filter((line) => /^# (?!#)/.test(line.text));
  if (titles.length === 0 || !titles[0]!.text.slice(2).trim()) return { ok: false, value: null, issues: [issue("team_name_missing", "Team Markdown is missing its # team name", "name")] };
  const name = titles[0]!.text.slice(2).trim();
  if (name.length > MAX_TEAM_NAME) return { ok: false, value: null, issues: [issue("team_name_too_long", "Team name is too long", "name", titles[0]!.number)] };
  const teamHeadings = body.filter((line) => line.text.trim() === "## Team");
  if (teamHeadings.length === 0) return { ok: false, value: null, issues: [issue("team_section_missing", "Team Markdown is missing its ## Team section", "members")] };
  if (teamHeadings.length > 1) return { ok: false, value: null, issues: [issue("team_section_ambiguous", "Team Markdown contains more than one ## Team section", "members", teamHeadings[1]!.number)] };
  const teamStart = body.indexOf(teamHeadings[0]!) + 1;
  const nextSectionOffset = body.slice(teamStart).findIndex((line) => /^## (?!#)/.test(line.text));
  const teamLines = nextSectionOffset < 0 ? body.slice(teamStart) : body.slice(teamStart, teamStart + nextSectionOffset);
  const memberStarts = teamLines.flatMap((line, index) => line.text.startsWith("### ") ? [index] : []);
  if (memberStarts.length === 0) return { ok: false, value: null, issues: [issue("members_empty", "Team Markdown needs at least one member", "members", teamHeadings[0]!.number)] };
  if (memberStarts.length > TEAM_MARKDOWN_MAX_MEMBERS) return { ok: false, value: null, issues: [issue("members_too_many", `Team Markdown supports at most ${TEAM_MARKDOWN_MAX_MEMBERS} members`, "members")] };

  const issues: TeamMarkdownIssue[] = [];
  const members: TeamMarkdownMember[] = [];
  const keys = new Set<string>();
  const names = new Set<string>();
  for (const [memberIndex, start] of memberStarts.entries()) {
    const end = memberStarts[memberIndex + 1] ?? teamLines.length;
    const block = teamLines.slice(start, end);
    const header = block[0]!;
    const match = /^###\s+(.+?)\s+—\s+(.+?)\s*$/.exec(header.text);
    const basePath = `members.${memberIndex}`;
    if (!match) {
      issues.push(issue("member_header_invalid", "Member heading must be: ### Name — Role", basePath, header.number));
      continue;
    }
    const nameValue = match[1]!.trim();
    const role = match[2]!.trim();
    if (nameValue.length > MAX_MEMBER_NAME) issues.push(issue("member_name_too_long", "Member name is too long", `${basePath}.name`, header.number));
    if (role.length > MAX_ROLE) issues.push(issue("member_role_too_long", "Member role is too long", `${basePath}.role`, header.number));
    const keyLines = block.filter((line) => line.text.trim().startsWith("**Role key:**"));
    if (keyLines.length === 0) {
      issues.push(issue("member_key_missing", "Member is missing **Role key:** `key`", `${basePath}.key`, header.number));
      continue;
    }
    if (keyLines.length > 1) {
      issues.push(issue("member_key_ambiguous", "Member contains more than one Role key", `${basePath}.key`, keyLines[1]!.number));
      continue;
    }
    const keyMatch = /^\*\*Role key:\*\*\s*`([^`]+)`\s*$/.exec(keyLines[0]!.text.trim());
    if (!keyMatch || !MEMBER_KEY.test(keyMatch[1]!)) {
      issues.push(issue("member_key_invalid", "Role key must use lowercase letters, numbers, - or _", `${basePath}.key`, keyLines[0]!.number));
      continue;
    }
    const key = keyMatch[1]!;
    if (keys.has(key)) issues.push(issue("member_key_duplicate", `Duplicate member key: ${key}`, `${basePath}.key`, keyLines[0]!.number));
    keys.add(key);
    const normalizedName = normalizedIdentity(nameValue);
    if (names.has(normalizedName)) issues.push(issue("member_name_duplicate", `Duplicate member name: ${nameValue}`, `${basePath}.name`, header.number));
    names.add(normalizedName);
    const keyIndex = block.indexOf(keyLines[0]!);
    const instructionLines = block.slice(keyIndex + 1).filter((line) => !line.text.trim().startsWith("**Use these playbooks:**"));
    const instructions = instructionLines.map((line) => line.text).join("\n").trim();
    if (!instructions) issues.push(issue("member_instructions_missing", "Member needs explicit instructions", `${basePath}.instructions`, header.number));
    else if (instructions.length > MAX_INSTRUCTIONS) issues.push(issue("member_instructions_too_long", "Member instructions are too long", `${basePath}.instructions`, instructionLines[0]?.number));
    members.push({ key, name: nameValue, role, instructions, playbooks: [] });
  }
  if (issues.length) return { ok: false, value: null, issues };
  return {
    ok: true,
    issues: [],
    value: { format: TEAM_MARKDOWN_FORMAT, version: TEAM_MARKDOWN_VERSION, name, sourceId: null, release: null, members, chiefOfStaff: members[0]!.key, rooms: [], routines: [], playbooks: [], connections: [] },
  };
}

/** Parse ou lève une erreur structurée adaptée aux frontières API/UI. */
export function parseTeamMarkdown(input: unknown): ParsedTeamMarkdown {
  const result = validateTeamMarkdown(input);
  if (!result.ok) throw new TeamMarkdownError(result.issues);
  return result.value;
}

/**
 * Sérialise le même contrat BotMRR v1 que le parseur ci-dessus. La fonction
 * s'auto-valide avant de rendre le document : un export ne peut donc jamais
 * prétendre être portable s'il sort du sous-ensemble réellement importable.
 */
export function serializeTeamMarkdown(input: TeamMarkdownExportInput): string {
  const metadata = {
    botmrr: TEAM_MARKDOWN_VERSION,
    id: input.sourceId,
    release: input.release,
    name: input.name,
    requirements: { apps: input.connections.map((connection) => ({ ...connection })) },
    agents: input.members.map((member) => ({
      key: member.key,
      name: member.name,
      title: member.role,
      description: member.instructions,
      playbooks: [...member.playbooks],
    })),
    chiefOfStaff: input.chiefOfStaff,
    rooms: input.rooms.map((room) => ({
      key: room.key,
      name: room.name,
      members: [...room.members],
      bulletin: room.instructions,
      defaultResponder: room.defaultResponder.kind === "member"
        ? { kind: "agent", agent: room.defaultResponder.member }
        : { kind: room.defaultResponder.kind },
    })),
    routines: input.routines.map((routine) => ({
      key: routine.key,
      name: routine.name,
      agent: routine.agent,
      prompt: routine.prompt,
      runOn: routine.runOn,
      schedule: {
        type: "daily",
        time: routine.schedule.time,
        weekdays: [...routine.schedule.weekdays],
      },
      durationMinutes: routine.durationMinutes,
      enabledAfterInstall: routine.enabledAfterInstall === true,
    })),
    playbooks: input.playbooks.map((playbook) => ({
      ...playbook,
      triggers: [...playbook.triggers],
    })),
  };
  const members = input.members.map((member) =>
    `- **${member.name.replaceAll("\n", " ")}** (\`${member.key}\`) — ${member.role.replaceAll("\n", " ")}`,
  );
  const notes = input.limitations?.length
    ? ["", "## Export limitations", "", ...input.limitations.map((entry) => `- ${entry}`)]
    : [];
  const markdown = [
    "---",
    stringifyYaml(metadata, { lineWidth: 0 }).trimEnd(),
    "---",
    `# ${input.name.replaceAll("\n", " ")}`,
    "",
    "## Team",
    "",
    ...members,
    ...notes,
    "",
  ].join("\n");
  const validated = validateTeamMarkdown(markdown);
  if (!validated.ok) throw new TeamMarkdownError(validated.issues);
  return markdown;
}
