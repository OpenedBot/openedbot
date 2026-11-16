/**
 * Workspace files a reply cites as plain paths.
 *
 * A bot is asked to deliver a file with a `MEDIA:/workspace/<name>` line
 * (`FILE_DELIVERY_RULE`, roster bot-mode.ts). Hermes' own api_server platform
 * hint tells the model the opposite (write paths as plain text), and some
 * models follow it: the reply says « `/workspace/notes.md` contient … » and
 * nothing reaches the thread. The worker therefore also reads plain
 * references, so a file the bot made and named is attached either way. The
 * reply text is left exactly as the model wrote it.
 *
 * Only a file path inside `/workspace` qualifies: no `.`/`..` or hidden
 * segment, no sensitive path, no glob, and a deliverable extension (which
 * also rules out a directory). A path inside a fenced command block
 * (```bash, ```sh, … or a fence with no language) is a command argument, not
 * a delivery, and is ignored; inline code and prose count.
 */

import { ATTACHMENT_LIMITS } from "@openedbot/conversation/domain/attachments";
import { MEDIA_TAG, mediaBasename, mediaPath } from "./output-media-text";
import { isSensitiveRuntimePath, turnWrites } from "./runtime-artifacts";

const WORKSPACE_PREFIX = "/workspace/";

export type DeliverableType = { contentType: string; kind: "image" | "document" };

const DELIVERABLE_BY_EXTENSION: Readonly<Record<string, DeliverableType>> = {
  png: { contentType: "image/png", kind: "image" },
  jpg: { contentType: "image/jpeg", kind: "image" },
  jpeg: { contentType: "image/jpeg", kind: "image" },
  webp: { contentType: "image/webp", kind: "image" },
  pdf: { contentType: "application/pdf", kind: "document" },
  md: { contentType: "text/markdown", kind: "document" },
  markdown: { contentType: "text/markdown", kind: "document" },
  txt: { contentType: "text/plain", kind: "document" },
  csv: { contentType: "text/csv", kind: "document" },
  json: { contentType: "application/json", kind: "document" },
  html: { contentType: "text/html", kind: "document" },
  htm: { contentType: "text/html", kind: "document" },
};

/** Fence languages whose content is a command, not prose. */
const COMMAND_FENCES = new Set(["", "bash", "sh", "shell", "zsh", "fish", "console", "terminal", "shell-session", "ps", "ps1", "powershell", "cmd", "bat"]);

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;

/**
 * `/workspace/` not glued to a longer path (`/srv/workspace/…`, `~/workspace`,
 * `file:///workspace`), then everything up to a space, a quote (straight,
 * curly or French), a bracket or a list separator.
 */
const PLAIN_PATH = /(?<![\w.~/\\-])\/workspace\/([^\s`'"«»‹›“”‘’<>()[\]{}|,;]+)/g;

const TRAILING = /[.,;:!?…*]+$/;
const SEGMENT = /^[^\s.\\/%][^\s\\/%]{0,127}$/u;
const MAX_PATH_LENGTH = 255;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
}

/** `notes.md` → text/markdown; anything not deliverable → `null`. */
export function deliverableType(path: string): DeliverableType | null {
  return DELIVERABLE_BY_EXTENSION[extensionOf(mediaBasename(path))] ?? null;
}

/** A text deliverable (Markdown, plain text, CSV, JSON, HTML), not an image or a PDF. */
export function isTextDeliverable(path: string): boolean {
  const type = deliverableType(path);
  return type !== null && type.kind === "document" && type.contentType !== "application/pdf";
}

/** A workspace-relative file path, or `null` when it may not be delivered. */
function workspaceRelative(raw: string): string | null {
  const path = raw.replace(TRAILING, "");
  if (!path || path.length > MAX_PATH_LENGTH || /[*?]/.test(path)) return null;
  const segments = path.split("/");
  if (!segments.every((segment) => SEGMENT.test(segment))) return null;
  if (isSensitiveRuntimePath(`${WORKSPACE_PREFIX}${path}`)) return null;
  return deliverableType(path) ? path : null;
}

/** The text with fenced command blocks blanked out; other fences are kept. */
function withoutCommandFences(text: string): string {
  const kept: string[] = [];
  let open: { marker: string; command: boolean } | null = null;
  for (const line of text.split("\n")) {
    const fence = FENCE.exec(line);
    if (open) {
      if (fence && fence[1]!.startsWith(open.marker) && line.trim() === fence[1]) {
        open = null;
        kept.push("");
      } else {
        kept.push(open.command ? "" : line);
      }
      continue;
    }
    if (fence) {
      open = { marker: fence[1]!, command: COMMAND_FENCES.has(fence[2]!.toLowerCase()) };
      kept.push("");
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

/**
 * The files a reply names as plain `/workspace/<path>` references, relative
 * to `/workspace`, without duplicates, in order. A file already named by a
 * `MEDIA:` line is left to that delivery. Capped at the attachment count of a
 * message.
 */
export function citedWorkspacePaths(output: unknown): string[] {
  if (typeof output !== "string" || !output.includes(WORKSPACE_PREFIX)) return [];
  const viaMedia = new Set<string>();
  const prose = withoutCommandFences(output).replace(MEDIA_TAG, (_match, lead: string, raw: string) => {
    const path = mediaPath(raw);
    if (path.startsWith(WORKSPACE_PREFIX)) viaMedia.add(path.slice(WORKSPACE_PREFIX.length));
    return lead;
  });
  const cited = new Set<string>();
  for (const match of prose.matchAll(PLAIN_PATH)) {
    const path = workspaceRelative(match[1]!);
    if (path && !viaMedia.has(path)) cited.add(path);
    if (cited.size >= ATTACHMENT_LIMITS.maxCount) break;
  }
  return [...cited];
}

/**
 * The last content this turn's write calls gave `/workspace/<path>`, or
 * `null`. A relative write path is read from `/workspace`, the sandbox's
 * working directory.
 */
export function writtenWorkspaceText(messages: unknown, path: string): string | null {
  const targets = new Set([`${WORKSPACE_PREFIX}${path}`, path, `./${path}`]);
  let content: string | null = null;
  for (const write of turnWrites(messages)) {
    if (targets.has(write.path.replace(/\\/g, "/"))) content = write.content;
  }
  return content;
}
