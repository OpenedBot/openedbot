import type { HermesBundleImportDto, RuntimeProfileImportDto } from "@openedbot/contracts-api";
import { useT } from "../lib/i18n";

export function ProfileImportReport({ result }: { result: RuntimeProfileImportDto }) {
  const { t } = useT();
  return <div className="space-y-3" role="status">
    <p>{t("profileImport.success", { count: result.imported.length })}</p>
    <ul>{result.imported.map((item) => <li key={item.botId}>{item.name} · {item.slug}</li>)}</ul>
    <p>{t("profileImport.reportCounts", { groups: result.groups.length, routines: result.routines.length, skipped: result.skipped.length })}</p>
    {result.groups.length ? <details><summary>{t("profileImport.groups")}</summary><ul>{result.groups.map((group) => <li key={group.groupId}>{group.name} · {group.memberSlugs.join(", ")}</li>)}</ul></details> : null}
    {result.routines.length ? <details><summary>{t("profileImport.routines", { count: result.routines.length })}</summary><ul>{result.routines.map((routine) => <li key={routine.routineId}>{routine.name} · {routine.slug} · {routine.schedule} UTC</li>)}</ul></details> : null}
    {result.skipped.map((item) => <p key={item.slug}>{item.slug} · {t(item.reason === "hidden" ? "profileImport.hidden" : "profileImport.notInInventory")}</p>)}
    <ul className="space-y-2 text-sm text-muted-foreground">{result.limitations.map((note, i) => <li key={`${i}:${note}`}><ImportLimitation note={note} /></li>)}</ul>
    {"capabilities" in result ? (result as HermesBundleImportDto).capabilities.map((item) => <details key={item.slug}>
      <summary>{t("profileImport.capabilities")} · {item.slug}</summary>
      {(["toolsets", "mcpServers", "skills"] as const).map((kind) => <p key={kind}>{kind}: {item[kind].map((flag) => `${flag.name} (${t(flag.enabled ? "profileImport.enabled" : "profileImport.disabled")})`).join(", ") || "-"}</p>)}
    </details>) : null}
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
