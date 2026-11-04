import { sanitizeToolErrorMessage } from "@openedbot/execution/domain/tool-text";
import { toolKind, toolService } from "@openedbot/conversation/domain/thread-tools";
import type { useT } from "../i18n";

type Translate = ReturnType<typeof useT>["t"];

/** A query longer than this is cut: the status line is one short sentence. */
export const PROGRESS_QUERY_MAX_CHARS = 60;
/** A host or a file name longer than this is cut. */
export const PROGRESS_TARGET_MAX_CHARS = 40;

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function stripQuotes(text: string): string {
  return text.replace(/^["'`[(]+|["'`\]),;:]+$/g, "").trim();
}

/** The search terms of a `web_search` preview, or `null` when it holds none. */
export function searchQuery(preview: string): string | null {
  const query = stripQuotes(preview);
  // A query that carries a URL or `name=value` pairs may hold a credential the
  // secret masker does not know by name: such a preview gets the generic verb.
  if (!query || /:\/\/|[?&][^\s=&]+=|\b[a-z_][a-z0-9_-]*=\S/i.test(query)) return null;
  return cut(query, PROGRESS_QUERY_MAX_CHARS);
}

/**
 * The site of the first URL (or bare domain) of a preview: the host only,
 * never the path or the query string, which is where tokens hide.
 */
function siteOf(preview: string): string | null {
  const found = /https?:\/\/[^\s"'<>\])]+/i.exec(preview)?.[0]
    ?? /(?:^|[\s"'[(])((?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#][^\s"'<>\])]*)?)/i.exec(preview)?.[1];
  if (!found) return null;
  try {
    const host = new URL(/^https?:\/\//i.test(found) ? found : `https://${found}`).hostname.replace(/^www\./i, "");
    return host ? cut(host, PROGRESS_TARGET_MAX_CHARS) : null;
  } catch {
    return null;
  }
}

/** A file name only (no directory), when the preview starts with a plain path. */
function fileNameOf(preview: string): string | null {
  const token = stripQuotes(preview.split(/\s+/)[0] ?? "");
  const base = token.split(/[\\/]/).at(-1) ?? "";
  if (!base || base === "." || base === "..") return null;
  return /^[\p{L}\p{N}._@+()~-]+$/u.test(base) ? cut(base, PROGRESS_TARGET_MAX_CHARS) : null;
}

/**
 * What a running tool is doing, as one short line for the live status:
 * « Recherche : cours du bitcoin » for `web_search` (the query), « Lecture :
 * lemonde.fr » for `web_extract` (the host), « Écrit note.txt » for
 * `write_file` (the file name). Every other tool, and every tool whose
 * preview does not hold a safe field, gets the translated family verb
 * (« Exécute des commandes… »): a command line, a payload or a URL path is
 * never shown. The preview is what Hermes sent with `tool.started`
 * (`hermes-events.ts`), cleaned once more here (terminal controls, secrets,
 * bounded); with none, the generic verb is the whole truth.
 */
export function toolProgressLabel(t: Translate, tool: string, preview?: string | null): string {
  const bare = tool.replace(/^mcp__.+?__/, "");
  const text = sanitizeToolErrorMessage(preview);
  const kind = toolKind(tool);
  if (text) {
    if (kind === "search") {
      const query = searchQuery(text);
      if (query) return t("agentActivity.progressSearch", { query });
    } else if (bare === "web_extract" || bare === "http" || bare.startsWith("browser_")) {
      const site = siteOf(text);
      if (site) return t("agentActivity.progressWeb", { site });
    } else if (bare === "read_file" || bare === "cat") {
      const file = fileNameOf(text);
      if (file) return t("agentActivity.progressRead", { file });
    } else if (bare === "write_file") {
      const file = fileNameOf(text);
      if (file) return t("agentActivity.progressWrite", { file });
    } else if (bare === "patch" || bare === "edit_file") {
      const file = fileNameOf(text);
      if (file) return t("agentActivity.progressEdit", { file });
    }
  }
  switch (kind) {
    case "search": return t("agentActivity.kindSearch");
    case "web": return t("agentActivity.kindWeb");
    case "read": return t("agentActivity.kindRead");
    case "edit": return t("agentActivity.kindEdit");
    case "run": return t("agentActivity.kindRun");
    case "code": return t("agentActivity.kindCode");
    case "delegate": return t("agentActivity.kindDelegate");
    case "mcp": return t("agentActivity.kindMcp", { service: toolService(tool) ?? tool });
    case "other": return t("agentActivity.usingTool", { tool });
  }
}
