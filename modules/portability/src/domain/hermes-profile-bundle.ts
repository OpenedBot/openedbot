import { isAlias, isCollection, isPair, parseDocument } from "yaml";
import type { HermesImportNamedFlag, HermesProfileImportEntry } from "@openedbot/contracts-api";

export const HERMES_IMPORT_MAX_JSON_BYTES = 8 * 1024 * 1024;
export const HERMES_IMPORT_MAX_FILE_BYTES = 1024 * 1024;
export const HERMES_PROFILE_SLUG = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export type HermesArchiveEntry = { path: string; bytes: Uint8Array; type?: "file" | "directory" | "symlink" | "unsupported" };
export type HermesArchiveDrop = { path: string; reason: "secret" | "runtime-data" | "too-large" | "duplicate" | "symlink" | "path-invalid" | "unsupported-entry" };
export type HermesProfileIssue = { slug: string; code: "slug-invalid" | "slug-duplicate" | "default-profile" | "no-config" | "config-invalid" | "soul-too-long" | "cron-invalid" };
export type HermesProfileFiles = Record<string, Uint8Array>;
const AVATARS = ["avatar.png", "avatar.webp", "avatar.jpg", "avatar.jpeg", "avatar.gif", "assets/avatar.png", "assets/avatar.webp"];
const CRON_FILES = ["cron/jobs.json", "cronjobs.json", "cron.json"];

export function hermesArchiveSlug(name: string): string {
  return name.replace(/\.(tar\.gz|tgz|zip)$/i, "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+|[-_]+$/g, "").slice(0, 63);
}

/** Normalize archive names only. No filesystem operation or URL resolution is involved. */
export function normalizeHermesArchivePath(path: string): string | null {
  if (!path || path.startsWith("/") || path.includes("\\") || /[\x00-\x1f\x7f]/.test(path) || /^[A-Za-z]:/.test(path)) return null;
  const parts = path.split("/");
  if (parts.includes("..")) return null;
  const normalized = parts.filter((part) => part && part !== ".").join("/");
  return normalized.length > 0 && normalized.length <= 4096 ? normalized : null;
}

export function hermesArchiveDropReason(path: string): HermesArchiveDrop["reason"] | null {
  const parts = path.toLowerCase().split("/");
  if (parts.some((part) => part.startsWith(".env") || part === "auth.json" || part === "runtime.env")) return "secret";
  if (parts.some((part) => ["memories", "sessions", "logs", "pairing"].includes(part) || part.startsWith("workspace") || part.startsWith("state") || part.endsWith("_cache") || /\.(db|sqlite\w*)$/.test(part))) return "runtime-data";
  return null;
}

export function collectHermesProfiles(input: { entries: HermesArchiveEntry[]; archiveName: string }): {
  candidates: Array<{ slug: string; root: boolean; files: HermesProfileFiles }>;
  dropped: HermesArchiveDrop[]; issues: HermesProfileIssue[];
} {
  const dropped: HermesArchiveDrop[] = [];
  const issues: HermesProfileIssue[] = [];
  const paths = input.entries.map((entry) => ({ ...entry, normalized: normalizeHermesArchivePath(entry.path) }));
  const counts = new Map<string, number>();
  for (const entry of paths) if (entry.normalized && entry.type !== "directory") counts.set(entry.normalized, (counts.get(entry.normalized) ?? 0) + 1);
  const kept = new Map<string, Uint8Array>();
  for (const entry of paths) {
    const path = entry.normalized;
    const reason = !path ? "path-invalid" : entry.type === "symlink" ? "symlink" : entry.type === "unsupported" ? "unsupported-entry"
      : hermesArchiveDropReason(path) ?? ((counts.get(path) ?? 0) > 1 ? "duplicate" : null);
    if (reason) { dropped.push({ path: entry.path, reason }); continue; }
    if (entry.type === "directory") continue;
    const basename = path!.split("/").at(-1)!;
    const skill = /(?:^|\/)skills\/[^/]+\/SKILL\.md$/i.test(path!);
    const useful = basename === "config.yaml" || ["SOUL.md", "soul.md"].includes(basename)
      || CRON_FILES.some((name) => path === name || path!.endsWith("/" + name))
      || AVATARS.some((name) => path === name || path!.endsWith("/" + name)) || skill;
    if (!useful) { dropped.push({ path: entry.path, reason: "unsupported-entry" }); continue; }
    const max = AVATARS.some((name) => path === name || path!.endsWith("/" + name)) ? 128 * 1024 : HERMES_IMPORT_MAX_FILE_BYTES;
    if (!skill && entry.bytes.byteLength > max) { dropped.push({ path: entry.path, reason: "too-large" }); continue; }
    // Skill contents are discarded here; their names alone are useful.
    kept.set(path!, skill ? new Uint8Array() : entry.bytes);
  }
  const candidates: Array<{ slug: string; root: boolean; files: HermesProfileFiles }> = [];
  for (const path of kept.keys()) {
    if (path !== "config.yaml" && !path.endsWith("/config.yaml")) continue;
    const parent = path === "config.yaml" ? "" : path.slice(0, -"/config.yaml".length);
    const slug = parent ? parent.split("/").at(-1)! : hermesArchiveSlug(input.archiveName);
    const prefix = parent ? parent + "/" : "";
    const isHome = parent.split("/").at(-1) === ".hermes" || paths.some((entry) => entry.normalized?.startsWith(prefix + "profiles/"));
    if (slug === "default" || isHome) { issues.push({ slug, code: "default-profile" }); continue; }
    if (!HERMES_PROFILE_SLUG.test(slug)) { issues.push({ slug, code: "slug-invalid" }); continue; }
    const files: HermesProfileFiles = Object.create(null);
    for (const [file, bytes] of kept) {
      if (!file.startsWith(prefix)) continue;
      const relative = file.slice(prefix.length);
      if (["config.yaml", "SOUL.md", "soul.md", ...CRON_FILES, ...AVATARS].includes(relative) || /^skills\/[^/]+\/SKILL\.md$/i.test(relative)) files[relative] = bytes;
    }
    candidates.push({ slug, root: !parent, files });
  }
  const slugs = new Map<string, number>();
  for (const candidate of candidates) slugs.set(candidate.slug, (slugs.get(candidate.slug) ?? 0) + 1);
  for (const [slug, count] of slugs) if (count > 1) issues.push({ slug, code: "slug-duplicate" });
  if (!candidates.length && !issues.length) issues.push({ slug: hermesArchiveSlug(input.archiveName), code: "no-config" });
  return { candidates: candidates.filter((candidate) => slugs.get(candidate.slug) === 1), dropped, issues };
}

export function parseHermesProfileFiles(slug: string, files: HermesProfileFiles):
  | { entry: HermesProfileImportEntry; ignoredKeys: string[]; notes: string[] }
  | { issue: HermesProfileIssue } {
  let config: Record<string, unknown>;
  const notes: string[] = [];
  const ignoredKeys: string[] = [];
  try {
    if (!HERMES_PROFILE_SLUG.test(slug) || slug === "default" || !files["config.yaml"]) throw new Error();
    config = parseBoundedConfig(files["config.yaml"]);
  } catch { return { issue: { slug, code: "config-invalid" } }; }
  const known = new Set(["model", "display_name", "name", "description", "persona", "ui_meta", "platform_toolsets", "toolsets", "enabled_toolsets", "mcp_servers", "mcpServers", "disabled_skills", "skills"]);
  for (const key of Object.keys(config)) if (!known.has(key)) ignoredKeys.push(key);
  const soulBytes = files["SOUL.md"] ?? files["soul.md"];
  let soul: string | null = null;
  try {
    if (soulBytes) {
      const raw = decode(soulBytes);
      if (raw.length > 8000) return { issue: { slug, code: "soul-too-long" } };
      let skipping = false;
      soul = raw.split(/\r?\n/).filter((line) => {
        const trimmed = line.trim();
        if (trimmed.toLowerCase().startsWith("## messaging other agents")) { skipping = true; return false; }
        if (skipping && trimmed.startsWith("## ")) skipping = false;
        return !skipping;
      }).join("\n").trim() || null;
    }
  } catch { return { issue: { slug, code: "config-invalid" } }; }
  const rawModel = config.model;
  const model = typeof rawModel === "string" ? { default: text(rawModel, 200), provider: null }
    : { default: text(record(rawModel).default ?? record(rawModel).model ?? record(rawModel).id, 200), provider: text(record(rawModel).provider, 64) };
  for (const key of Object.keys(record(rawModel))) if (!["default", "model", "id", "provider"].includes(key)) ignoredKeys.push(`model.${key}`);
  const uiRoot = record(config.ui_meta);
  const ui = record(uiRoot["hermes-bots"] ?? uiRoot.hermes_bots ?? config.ui_meta);
  const uiMeta: HermesProfileImportEntry["uiMeta"] = Object.keys(ui).length ? {
    title: text(ui.title, 120), color: text(ui.color, 32), shape: text(ui.shape, 32), imageKind: text(ui.imageKind ?? ui.image, 32),
    hidden: ui.hidden === true, pinned: ui.pinned === true, sectionId: text(ui.sectionId ?? ui.section_id, 64),
    groups: array(ui.groups).slice(0, 16).map((value) => text(typeof value === "string" ? value : record(value).name ?? record(value).id ?? record(value).title, 64)).filter((value): value is string => !!value),
    created: text(ui.created, 40),
  } : null;
  for (const key of Object.keys(ui)) if (!["title", "color", "shape", "imageKind", "image", "hidden", "pinned", "sectionId", "section_id", "groups", "created"].includes(key)) ignoredKeys.push(`ui_meta.${key}`);
  const platforms = record(config.platform_toolsets);
  const toolsets = flags(Object.hasOwn(platforms, "api_server") ? platforms.api_server : config.toolsets ?? config.enabled_toolsets, /^[a-z0-9][a-z0-9_]{0,63}$/, notes);
  for (const key of Object.keys(platforms)) if (key !== "api_server") ignoredKeys.push(`platform_toolsets.${key}`);
  const rawMcp = config.mcp_servers ?? config.mcpServers;
  const mcpServers = flags(rawMcp, /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, notes);
  for (const [name, value] of Object.entries(record(rawMcp))) for (const key of Object.keys(record(value))) if (key !== "enabled") ignoredKeys.push(`mcp_servers.${name}.${key}`);
  const disabled = new Set([...array(config.disabled_skills), ...array(record(config.skills).disabled)].filter((item): item is string => typeof item === "string").map((name) => name.trim().toLowerCase()));
  if (disabled.delete("hermes-agent")) notes.push(`skill-essential:${slug}:hermes-agent`);
  const skillNames = new Set(Object.keys(files).filter((path) => /^skills\/[^/]+\/SKILL\.md$/i.test(path)).map((path) => path.split("/")[1]!.toLowerCase()));
  for (const name of disabled) skillNames.add(name);
  const skills = [...skillNames].sort().filter((name) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)).slice(0, 64).map((name) => ({ name, enabled: !disabled.has(name) }));
  const routines: HermesProfileImportEntry["routines"] = [];
  const cronBytes = CRON_FILES.map((path) => files[path]).find(Boolean);
  if (cronBytes) {
    try {
      if (cronBytes.byteLength > HERMES_IMPORT_MAX_FILE_BYTES) throw new Error();
      const raw: unknown = JSON.parse(decode(cronBytes));
      const jobs = Array.isArray(raw) ? raw : record(raw).jobs ?? record(raw).cron ?? record(raw).items;
      if (!Array.isArray(jobs)) throw new Error();
      if (jobs.length > 20) notes.push(`routines-truncated:${slug}`);
      for (const item of jobs.slice(0, 20)) {
        const job = record(item);
        if (!Object.keys(job).length) continue;
        const name = (text(job.name ?? job.title ?? job.id, 120) ?? "routine").replace(/^\[bot:[^\]]+\]\s*/i, "").slice(0, 100) || "routine";
        const prompt = (text(job.prompt ?? job.message ?? job.input ?? job.command, HERMES_IMPORT_MAX_FILE_BYTES) ?? "")
          .replace(/^(?:This is an automated routine named ".+"\.|You are running as a scheduled routine named ".+"\.)\s*\n+/i, "").trim().slice(0, 4000);
        routines.push({ name, prompt, schedule: normalizeHermesSchedule(job.schedule ?? job.cron ?? job.expr), enabled: job.enabled !== false, deliver: (job.deliver ?? job.delivery) !== false, model: text(job.model, 200) });
      }
    } catch { return { issue: { slug, code: "cron-invalid" } }; }
  }
  let avatar: HermesProfileImportEntry["avatar"] = null;
  for (const path of AVATARS) {
    const bytes = files[path];
    if (!bytes) continue;
    if (bytes.byteLength > 128 * 1024) { notes.push(`avatar-too-large:${slug}`); break; }
    const contentType = path.endsWith(".png") ? "image/png" : path.endsWith(".webp") ? "image/webp" : path.endsWith(".gif") ? "image/gif" : "image/jpeg";
    if (!hermesImageSignatureMatches(contentType, bytes)) { notes.push(`avatar-not-imported:${slug}`); break; }
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    avatar = { contentType, base64: btoa(binary) }; break;
  }
  const displayName = text(ui.title ?? config.display_name ?? config.name, HERMES_IMPORT_MAX_FILE_BYTES) ?? slug;
  if (new TextEncoder().encode(displayName).byteLength > 120 || /[\x00-\x1f\x7f]/.test(displayName)) return { issue: { slug, code: "config-invalid" } };
  return {
    entry: { name: slug, displayName, title: uiMeta?.title ?? null, description: text(config.description ?? config.persona, 400), soul, model, uiMeta, hasAvatar: !!avatar, routines, skills, toolsets, mcpServers, avatar },
    ignoredKeys: [...new Set(ignoredKeys)], notes,
  };
}

export function normalizeHermesSchedule(value: unknown): string {
  if (typeof value === "string") return value.trim().slice(0, 120);
  const schedule = record(value);
  if (schedule.kind === "cron") return text(schedule.expr, 120) ?? "";
  if (schedule.kind === "once" && typeof schedule.run_at === "string") return "once";
  if (schedule.kind === "interval" && Number.isSafeInteger(schedule.minutes) && Number(schedule.minutes) > 0) return `every ${schedule.minutes}m`;
  return "";
}

function parseBoundedConfig(bytes: Uint8Array): Record<string, unknown> {
  if (bytes.byteLength > HERMES_IMPORT_MAX_FILE_BYTES) throw new Error();
  const document = parseDocument(decode(bytes), { strict: true, uniqueKeys: true, stringKeys: true });
  if (document.errors.length) throw new Error();
  const stack: Array<{ node: unknown; depth: number }> = [{ node: document.contents, depth: 0 }];
  let nodes = 0; let aliases = 0;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (++nodes > 10_000 || depth > 50) throw new Error();
    if (isAlias(node) && ++aliases > 50) throw new Error();
    if (isCollection(node)) for (const item of node.items) stack.push({ node: item, depth: depth + 1 });
    else if (isPair(node)) { stack.push({ node: node.key, depth: depth + 1 }, { node: node.value, depth: depth + 1 }); }
  }
  const result: unknown = document.toJS({ maxAliasCount: 50 });
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
  return result as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown, max: number): string | null { return typeof value === "string" ? value.trim().slice(0, max) || null : null; }
function decode(bytes: Uint8Array): string { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
function flags(raw: unknown, pattern: RegExp, notes: string[]): HermesImportNamedFlag[] {
  const input = Array.isArray(raw) ? raw.map((item) => typeof item === "string" ? { name: item, enabled: true } : { name: record(item).name ?? record(item).id ?? record(item).key, enabled: record(item).enabled !== false })
    : Object.entries(record(raw)).map(([name, value]) => ({ name, enabled: value !== false && record(value).enabled !== false }));
  const seen = new Set<string>();
  const result: HermesImportNamedFlag[] = [];
  for (const flag of input) {
    const name = typeof flag.name === "string" ? flag.name.trim() : "";
    if (!pattern.test(name) || seen.has(name)) { notes.push("capability-name-invalid"); continue; }
    seen.add(name); result.push({ name, enabled: flag.enabled });
  }
  if (result.length > 64) notes.push("capabilities-truncated");
  return result.slice(0, 64);
}

export function hermesImageSignatureMatches(type: string, bytes: Uint8Array): boolean {
  const head = String.fromCharCode(...bytes.subarray(0, 12));
  if (type === "image/png") return head.startsWith("\x89PNG\r\n\x1a\n");
  if (type === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (type === "image/gif") return head.startsWith("GIF87a") || head.startsWith("GIF89a");
  return type === "image/webp" && head.startsWith("RIFF") && head.slice(8, 12) === "WEBP";
}
