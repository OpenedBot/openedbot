import type { HermesBundleImportDto, RuntimeProfileImportDto } from "@openedbot/contracts-api";
import { IconCircleCheck } from "@tabler/icons-react";
import { useT } from "../lib/i18n";
import { ListRow, ListSection, ToneBadge } from "./settings/primitives";

/**
 * A note naming an imported slug goes under that agent's row, without the
 * slug. A note that every imported agent shares is said once, under the list.
 */
function splitLimitations(result: RuntimeProfileImportDto) {
  const slugs = new Set(result.imported.map((item) => item.slug));
  const parsed = result.limitations.map((note) => {
    const [code = "", ...context] = note.split(":");
    const slug = context.find((part) => slugs.has(part));
    return { note, code, slug, rest: [code, ...context.filter((part) => part !== slug)].join(":") };
  });
  const shared = new Set([...new Set(parsed.map((item) => item.code))].filter((code) => slugs.size > 1
    && [...slugs].every((slug) => parsed.some((item) => item.code === code && item.slug === slug && item.rest === code))));
  const perAgent = new Map<string, string[]>();
  const general: string[] = [];
  for (const item of parsed) {
    if (shared.has(item.code) && item.rest === item.code) {
      if (!general.includes(item.code)) general.push(item.code);
    } else if (item.slug) perAgent.set(item.slug, [...(perAgent.get(item.slug) ?? []), item.rest]);
    else general.push(item.note);
  }
  return { perAgent, general };
}

export function ProfileImportReport({ result }: { result: RuntimeProfileImportDto }) {
  const { t } = useT();
  const { perAgent, general } = splitLimitations(result);
  const capabilities = "capabilities" in result ? (result as HermesBundleImportDto).capabilities : [];
  const hasCounts = result.groups.length + result.routines.length + result.skipped.length > 0;
  return <div className="flex flex-col gap-5" role="status">
    <ListSection
      title={t("profileImport.success", { count: result.imported.length })}
      description={hasCounts ? t("profileImport.reportCounts", { groups: result.groups.length, routines: result.routines.length, skipped: result.skipped.length }) : undefined}
      footer={general.length ? <ul className="space-y-1 text-xs leading-5 text-muted-foreground">
        {general.map((note, i) => <li key={`${i}:${note}`}><ImportLimitation note={note} /></li>)}
      </ul> : undefined}
    >
      {result.imported.map((item) => {
        const notes = perAgent.get(item.slug) ?? [];
        const flags = capabilities.find((entry) => entry.slug === item.slug);
        return <ListRow
          key={item.botId}
          icon={<IconCircleCheck className="text-pos-700" aria-hidden />}
          label={item.name}
          description={<>
            <span className="font-mono">{item.slug}</span>
            {notes.length ? <ul className="mt-1 space-y-0.5">{notes.map((note, i) => <li key={`${i}:${note}`}><ImportLimitation note={note} /></li>)}</ul> : null}
            {flags ? <details className="mt-1">
              <summary className="cursor-pointer">{t("profileImport.capabilities")}</summary>
              {(["toolsets", "mcpServers", "skills"] as const).map((kind) => <p key={kind}>{kind}: {flags[kind].map((flag) => `${flag.name} (${t(flag.enabled ? "profileImport.enabled" : "profileImport.disabled")})`).join(", ") || "-"}</p>)}
            </details> : null}
          </>}
        >
          <ToneBadge tone="info" className="whitespace-nowrap">{t("profileImport.inRoster")}</ToneBadge>
        </ListRow>;
      })}
    </ListSection>
    {result.groups.length ? <ListSection title={t("profileImport.groups")}>
      {result.groups.map((group) => <ListRow key={group.groupId} label={group.name} description={<span className="font-mono">{group.memberSlugs.join(", ")}</span>} />)}
    </ListSection> : null}
    {result.routines.length ? <ListSection title={t("profileImport.routines", { count: result.routines.length })}>
      {result.routines.map((routine) => <ListRow key={routine.routineId} label={routine.name} description={<span className="font-mono">{routine.slug}</span>} value={`${routine.schedule} UTC`} mono>
        <ToneBadge tone="neutral">{t("profileImport.routinePaused")}</ToneBadge>
      </ListRow>)}
    </ListSection> : null}
    {result.skipped.length ? <ListSection title={t("profileImport.skippedTitle")}>
      {result.skipped.map((item) => <ListRow key={item.slug} label={<span className="font-mono">{item.slug}</span>}>
        <ToneBadge tone="neutral">{t(item.reason === "hidden" ? "profileImport.hidden" : "profileImport.notInInventory")}</ToneBadge>
      </ListRow>)}
    </ListSection> : null}
  </div>;
}

export function ImportLimitation({ note }: { note: string }) {
  const { t } = useT();
  const [code, ...context] = note.split(":");
  const translated = NOTE_KEYS[code as keyof typeof NOTE_KEYS];
  if (translated) return <span>{t(translated)} {context.join(" · ")}</span>;
  const kind = code?.startsWith("model-") ? "model" : code?.startsWith("routine-") ? "routine"
    : code?.startsWith("avatar-") ? "avatar" : code?.startsWith("group-") ? "group"
    : code === "memory-restricted" ? "memory" : code === "capabilities-live-on-profile" ? "live"
    : code?.startsWith("mcp-restart") ? "restart" : "capability";
  return <span>{t(`profileImport.limitations.${kind}`)} {context.join(" · ")} <span className="text-xs">({code})</span></span>;
}

const NOTE_KEYS = {
  "model-not-available": "profileImport.notes.model-not-available",
  "profile-model-unset": "profileImport.notes.profile-model-unset",
  "routine-schedule-every-anchored": "profileImport.notes.routine-schedule-every-anchored",
  "routine-timezone-defaulted-to-utc": "profileImport.notes.routine-timezone-defaulted-to-utc",
  "routine-enabled-state-not-preserved": "profileImport.notes.routine-enabled-state-not-preserved",
  "routine-schedule-every": "profileImport.notes.routine-schedule-every",
  "routine-schedule-once": "profileImport.notes.routine-schedule-once",
  "routine-schedule-ambiguous": "profileImport.notes.routine-schedule-ambiguous",
  "routine-schedule-unsupported": "profileImport.notes.routine-schedule-unsupported",
  "routines-truncated": "profileImport.notes.routines-truncated",
  "avatar-too-large": "profileImport.notes.avatar-too-large",
  "avatar-not-imported": "profileImport.notes.avatar-not-imported",
  "avatar-cleanup-unconfirmed": "profileImport.notes.avatar-cleanup-unconfirmed",
  "group-size-out-of-bounds": "profileImport.notes.group-size-out-of-bounds",
  "capabilities-reread-failed": "profileImport.notes.capabilities-reread-failed",
  "per-bot-capabilities-not-applied": "profileImport.notes.per-bot-capabilities-not-applied",
  "capability-inherited": "profileImport.notes.capability-inherited",
  "mcp-restart-pending": "profileImport.notes.mcp-restart-pending",
  "mcp-server-unknown": "profileImport.notes.mcp-server-unknown",
  "mcp-inventory-unavailable": "profileImport.notes.mcp-inventory-unavailable",
  "skill-content-not-imported": "profileImport.notes.skill-content-not-imported",
  "skill-content-unverified": "profileImport.notes.skill-content-unverified",
  "skill-essential": "profileImport.notes.skill-essential",
  "toolset-forbidden": "profileImport.notes.toolset-forbidden",
  "capabilities-live-on-profile": "profileImport.notes.capabilities-live-on-profile",
  "memory-restricted": "profileImport.notes.memory-restricted",
  "profile-import-reviewed": "profileImport.notes.profile-import-reviewed",
  "config-invalid": "profileImport.notes.config-invalid",
  "cron-invalid": "profileImport.notes.cron-invalid",
  "soul-too-long": "profileImport.notes.soul-too-long",
  "slug-invalid": "profileImport.notes.slug-invalid",
  "slug-duplicate": "profileImport.notes.slug-duplicate",
  "default-profile": "profileImport.notes.default-profile",
  "no-config": "profileImport.notes.no-config",
  "capability-name-invalid": "profileImport.notes.capability-name-invalid",
  "capabilities-truncated": "profileImport.notes.capabilities-truncated",
  "configuration-fields-excluded": "profileImport.notes.configuration-fields-excluded",
  "model-not-applied": "profileImport.notes.model-not-applied",
  "model-write-failed": "profileImport.notes.model-write-failed",
  "toolset-not-applied": "profileImport.notes.toolset-not-applied",
  "toolset-write-failed": "profileImport.notes.toolset-write-failed",
  "mcp-server-not-applied": "profileImport.notes.mcp-server-not-applied",
  "mcp-server-write-failed": "profileImport.notes.mcp-server-write-failed",
  "skill-not-applied": "profileImport.notes.skill-not-applied",
  "skill-write-failed": "profileImport.notes.skill-write-failed"
} as const;
