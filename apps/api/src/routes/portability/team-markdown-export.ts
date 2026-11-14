import { createHash } from "node:crypto";
import {
  TEAM_MARKDOWN_MAX_MEMBERS,
  TEAM_MARKDOWN_MAX_ROOMS,
  TEAM_MARKDOWN_MAX_ROUTINES,
  serializeTeamMarkdown,
  type TeamMarkdownExportInput,
  type TeamMarkdownRoom,
  type TeamMarkdownRoutine,
} from "@openedbot/portability/domain/team-markdown";
import { parseCron } from "@openedbot/execution/domain/routines";
import type { TeamMarkdownExportDto } from "@openedbot/contracts-api";
import { HttpError } from "../../interfaces/http/http-error";

type OrganizationRow = { name: string; slug: string };
type ExportBotRow = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  instructions: string;
};
type ExportGroupRow = {
  id: string;
  name: string;
  instructions: string;
  defaultResponder: unknown;
};
type ExportGroupMemberRow = { groupId: string; botId: string };
type ExportRoutineRow = {
  id: string;
  botId: string | null;
  groupId: string | null;
  name: string;
  schedule: string;
  timezone: string;
  message: string;
  enabled: boolean;
};
type ExportPlaybookRow = {
  key: string;
  name: string;
  summary: string;
  triggers: string[];
  instructions: string;
  botIds: string[];
};

export type TeamExportSnapshot = {
  organization: OrganizationRow;
  bots: ExportBotRow[];
  groups: ExportGroupRow[];
  groupMembers: ExportGroupMemberRow[];
  routines: ExportRoutineRow[];
  playbooks?: ExportPlaybookRow[];
};

/**
 * Builds a BotMRR package from a snapshot already read. The team export
 * route has been removed; the Marketplace uses it to publish a bot.
 */
export function buildTeamMarkdownExport(snapshot: TeamExportSnapshot): TeamMarkdownExportDto {
  if (snapshot.bots.length === 0) {
    throw new HttpError(409, "TEAM_EXPORT_EMPTY", "Créez au moins un bot actif avant d’exporter l’équipe.");
  }
  if (snapshot.bots.length > TEAM_MARKDOWN_MAX_MEMBERS) {
    throw new HttpError(409, "TEAM_EXPORT_TOO_MANY_BOTS", `BotMRR accepte au plus ${TEAM_MARKDOWN_MAX_MEMBERS} bots par package.`);
  }
  const playbooks = snapshot.playbooks ?? [];
  const playbookKeysByBotId = new Map<string, string[]>();
  for (const playbook of playbooks) {
    for (const botId of playbook.botIds) {
      const keys = playbookKeysByBotId.get(botId) ?? [];
      keys.push(playbook.key);
      playbookKeysByBotId.set(botId, keys);
    }
  }
  const members = snapshot.bots.map((bot) => ({
    key: bot.slug,
    name: bot.name.trim(),
    role: bot.description?.trim() || "Specialist",
    instructions: bot.instructions.trim(),
    playbooks: playbookKeysByBotId.get(bot.id) ?? [],
  }));
  const invalid = members.find((member) => !member.instructions);
  if (invalid) {
    throw new HttpError(409, "TEAM_EXPORT_BOT_INSTRUCTIONS_REQUIRED", `Le bot « ${invalid.name} » n’a pas d’instructions représentables dans BotMRR.`);
  }

  const limitations = [
    "chief-of-staff-defaulted-to-first-active-bot",
  ];
  const keyByBotId = new Map(snapshot.bots.map((bot) => [bot.id, bot.slug]));
  const rooms: TeamMarkdownRoom[] = [];
  for (const group of snapshot.groups) {
    const rows = snapshot.groupMembers.filter((member) => member.groupId === group.id);
    const groupKeys = rows.map((member) => keyByBotId.get(member.botId));
    if (groupKeys.some((key) => key === undefined) || groupKeys.length < 2 || groupKeys.length > 6) {
      limitations.push(`group-${group.id}-not-exported-members-not-representable`);
      continue;
    }
    if (rooms.length >= TEAM_MARKDOWN_MAX_ROOMS) {
      limitations.push(`group-${group.id}-not-exported-room-limit`);
      continue;
    }
    const keys = groupKeys as string[];
    const defaultResponder = exportResponder(group.defaultResponder, keyByBotId, keys);
    if (!defaultResponder) {
      limitations.push(`group-${group.id}-not-exported-responder-not-representable`);
      continue;
    }
    rooms.push({
      key: stableKey("room", group.id),
      name: group.name,
      members: keys,
      instructions: group.instructions,
      defaultResponder,
    });
  }

  const routines: TeamMarkdownRoutine[] = [];
  for (const routine of snapshot.routines) {
    if (routine.groupId) {
      limitations.push(`routine-${routine.id}-not-exported-targets-room`);
      continue;
    }
    const agent = routine.botId ? keyByBotId.get(routine.botId) : undefined;
    const schedule = exportDailySchedule(routine.schedule, routine.timezone);
    if (!agent || !schedule || routine.name.trim().length > 80) {
      limitations.push(`routine-${routine.id}-not-exported-schedule-or-name-not-representable`);
      continue;
    }
    if (routines.length >= TEAM_MARKDOWN_MAX_ROUTINES) {
      limitations.push(`routine-${routine.id}-not-exported-routine-limit`);
      continue;
    }
    routines.push({
      key: stableKey("routine", routine.id),
      name: routine.name,
      agent,
      prompt: routine.message,
      runOn: "cloud",
      schedule,
      durationMinutes: 30,
      enabledAfterInstall: routine.enabled,
    });
  }
  if (routines.length > 0) {
    limitations.push("routine-duration-defaulted-to-30-minutes", "routine-enabled-state-recorded-but-import-pauses");
  }

  const canonical = JSON.stringify({ organization: snapshot.organization, members, rooms, routines });
  const digest = createHash("sha256").update(canonical).digest("hex");
  const sourceId = `openedbot-${safePackageSlug(snapshot.organization.slug).slice(0, 48)}-${digest.slice(0, 12)}`;
  const release = "1.0.0";
  const team: TeamMarkdownExportInput = {
    format: "openedbot.team-markdown",
    version: 1,
    name: snapshot.organization.name,
    sourceId,
    release,
    members,
    chiefOfStaff: members[0]!.key,
    rooms,
    routines,
    playbooks: playbooks.map((playbook) => ({
      key: playbook.key,
      name: playbook.name,
      summary: playbook.summary,
      triggers: playbook.triggers,
      instructions: playbook.instructions,
    })),
    connections: [],
  };
  let markdown: string;
  try {
    markdown = serializeTeamMarkdown({ ...team, limitations });
  } catch {
    throw new HttpError(409, "TEAM_EXPORT_UNREPRESENTABLE", "L’équipe contient des noms ou instructions hors des limites BotMRR.");
  }
  return {
    format: team.format,
    version: team.version,
    teamName: team.name,
    sourceId,
    release,
    fileName: `${sourceId}.botmrr.md`,
    contentType: "text/markdown",
    markdown,
    counts: { bots: members.length, groups: rooms.length, routines: routines.length, playbooks: playbooks.length },
    limitations,
  };
}

function exportResponder(
  responder: unknown,
  keyByBotId: ReadonlyMap<string, string>,
  members: readonly string[],
): TeamMarkdownRoom["defaultResponder"] | null {
  if (!responder || typeof responder !== "object" || Array.isArray(responder)) return null;
  const value = responder as Record<string, unknown>;
  if (value.kind === "everyone" || value.kind === "mentions") return { kind: value.kind };
  if (value.kind !== "member" || typeof value.botId !== "string") return null;
  const member = keyByBotId.get(value.botId);
  return member && members.includes(member) ? { kind: "member", member } : null;
}

export function exportDailySchedule(schedule: string, timezone: string): TeamMarkdownRoutine["schedule"] | null {
  if (timezone !== "UTC") return null;
  const fields = parseCron(schedule);
  if (!fields || !fields.domStar || fields.month.size !== 12 || fields.minute.size !== 1 || fields.hour.size !== 1) return null;
  const minute = [...fields.minute][0]!;
  const hour = [...fields.hour][0]!;
  return {
    type: "daily",
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    weekdays: [...fields.dow].sort((a, b) => a - b),
  };
}

function stableKey(prefix: string, id: string): string {
  return `${prefix}-${id.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32)}`;
}

function safePackageSlug(value: string): string {
  const slug = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || "team";
}
