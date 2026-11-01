import { describe, expect, test } from "bun:test";
import { parseTeamMarkdown } from "@openedbot/portability/domain/team-markdown";
import { buildTeamMarkdownExport, exportDailySchedule, type TeamExportSnapshot } from "../src/routes/portability/team-markdown-export";

const snapshot: TeamExportSnapshot = {
  organization: { name: "Signal Desk", slug: "signal-desk" },
  bots: [
    { id: "bot-scout", name: "Scout", slug: "scout", description: "Researcher", instructions: "Find primary sources." },
    { id: "bot-editor", name: "Editor", slug: "editor", description: "Lead editor", instructions: "Separate evidence from inference." },
  ],
  groups: [{ id: "11111111-1111-4111-8111-111111111111", name: "Newsroom", instructions: "Share sources first.", defaultResponder: { kind: "member", botId: "bot-scout" } }],
  groupMembers: [
    { groupId: "11111111-1111-4111-8111-111111111111", botId: "bot-scout" },
    { groupId: "11111111-1111-4111-8111-111111111111", botId: "bot-editor" },
  ],
  routines: [{
    id: "22222222-2222-4222-8222-222222222222",
    botId: "bot-scout",
    groupId: null,
    name: "Morning brief",
    schedule: "30 8 * * 1,2,3,4,5",
    timezone: "UTC",
    message: "Prepare the brief.",
    enabled: true,
  }],
};

describe("Team Markdown export builder", () => {
  test("exporte un snapshot déterministe, relisible, sans champ runtime ou secret", () => {
    const one = buildTeamMarkdownExport(snapshot);
    const two = buildTeamMarkdownExport(snapshot);
    expect(two).toEqual(one);
    expect(one.counts).toEqual({ bots: 2, groups: 1, routines: 1, playbooks: 0 });
    expect(parseTeamMarkdown(one.markdown)).toMatchObject({
      members: [{ key: "scout" }, { key: "editor" }],
      rooms: [{ members: ["scout", "editor"], defaultResponder: { kind: "member", member: "scout" } }],
      routines: [{ enabledAfterInstall: true }],
    });
    expect(one.limitations).toContain("routine-enabled-state-recorded-but-import-pauses");
    expect(one.markdown).not.toMatch(/credential|hermes_profile|reasoning_effort/i);
  });

  test("omet explicitement les groupes et routines non représentables", () => {
    const result = buildTeamMarkdownExport({
      ...snapshot,
      groups: [{ ...snapshot.groups[0]!, defaultResponder: { kind: "member", botId: "missing" } }],
      routines: [{ ...snapshot.routines[0]!, timezone: "Europe/Paris" }],
    });
    expect(result.counts).toMatchObject({ groups: 0, routines: 0 });
    expect(result.limitations).toEqual(expect.arrayContaining([
      expect.stringContaining("not-exported-responder"),
      expect.stringContaining("not-exported-schedule"),
    ]));
  });

  test("liste les routines de salon dans limitations, sans les exporter comme agent", () => {
    const result = buildTeamMarkdownExport({
      ...snapshot,
      routines: [{
        ...snapshot.routines[0]!,
        botId: null,
        groupId: snapshot.groups[0]!.id,
      }],
    });
    expect(result.counts.routines).toBe(0);
    expect(result.limitations).toEqual(expect.arrayContaining([
      expect.stringContaining("not-exported-targets-room"),
    ]));
  });

  test("convertit seulement un cron journalier représentable en UTC", () => {
    expect(exportDailySchedule("30 8 * * 1-5", "UTC")).toEqual({ type: "daily", time: "08:30", weekdays: [1, 2, 3, 4, 5] });
    expect(exportDailySchedule("30 8 1 * *", "UTC")).toBeNull();
    expect(exportDailySchedule("30 8 * * *", "Europe/Paris")).toBeNull();
  });
});
