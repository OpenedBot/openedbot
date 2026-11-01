export const TOOL_ERROR_MESSAGE_MAX_CHARS = 500;

const QUOTED_DISPLAY_SECRET_PATTERN = /\b([a-z0-9_-]*(?:api[_-]?key|token|secret|password|passwd|credential|authorization|cookie)[a-z0-9_-]*)(["']\s*:\s*)(["'])(?:\\.|(?!\3)[^\\])*\3/gi;

const TOOL_ERROR_SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/gi,
  /\b([a-z0-9_-]*(?:api[_-]?key|token|secret|password|passwd|credential)[a-z0-9_-]*)(\s*[:=]\s*)(["']?)[^\s"',;]{4,}\3/gi,
  /\b(?:sk|rk|pk)-[a-z0-9_-]{16,}/gi,
  /\b(?:sk-ant|ghp|gho|ghu|ghs|ghr|xox[abprs])[-_][a-z0-9_-]{12,}/gi,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

function stripTerminalControls(raw: string): string {
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function replaceSecrets(text: string): string {
  let redacted = text.replace(
    QUOTED_DISPLAY_SECRET_PATTERN,
    (_match, name: string, separator: string, quote: string) => `${name}${separator}${quote}[redacted]${quote}`,
  );
  for (const pattern of TOOL_ERROR_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match, name?: string, separator?: string) =>
      typeof name === "string" && typeof separator === "string"
        ? `${name}${separator}[redacted]`
        : "[redacted]",
    );
  }
  return redacted;
}

/** Masque les secrets sans aplatir les retours à la ligne des commandes. */
export function redactSecrets(raw: string): string {
  return replaceSecrets(stripTerminalControls(raw));
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Nettoie, masque et borne un motif avant sa persistance ou son affichage. */
export function sanitizeToolErrorMessage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let text = replaceSecrets(collapseWhitespace(stripTerminalControls(raw)));
  if (!text) return null;
  if (text.length > TOOL_ERROR_MESSAGE_MAX_CHARS) {
    text = `${text.slice(0, TOOL_ERROR_MESSAGE_MAX_CHARS - 1).trimEnd()}…`;
  }
  return text;
}
