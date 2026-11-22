/**
 * Lecture des entrées et des résultats d'un outil : le langage du bloc
 * d'entrée et le résultat structuré qu'Hermes renvoie. Pure, sans dépendance
 * au reste de `thread-tools.ts`, qui la réexporte.
 */

export type ParsedToolResult = {
  status?: string;
  output?: string;
  error?: string;
  exitCode?: number;
  durationSeconds?: number;
  toolCallsMade?: number;
  webResults?: Array<{ url: string; title?: string; error?: string }>;
};

/** Langage du bloc d'entrée, déterminé par l'outil et, pour les fichiers, leur chemin. */
export function toolInputLanguage(tool: string, input?: string): string {
  const bare = tool.replace(/^mcp__.+?__/, "");
  if (bare === "execute_code") return "python";
  if (bare === "terminal" || bare === "shell") return "bash";
  if (bare === "write_file" || bare === "patch") {
    let path = input?.split("\n", 1)[0]?.replace(/^path:\s*/i, "") ?? "";
    try {
      const value: unknown = JSON.parse(input ?? "");
      if (value && typeof value === "object" && "path" in value && typeof value.path === "string") path = value.path;
    } catch {
      // L'entrée peut déjà être présentée comme « chemin puis contenu ».
    }
    const extension = path.split("/").at(-1)?.split(".").at(-1)?.toLowerCase();
    const languages: Record<string, string> = {
      bash: "bash", c: "c", css: "css", go: "go", html: "html", java: "java",
      js: "javascript", jsx: "jsx", json: "json", md: "markdown", mjs: "javascript",
      py: "python", rs: "rust", sql: "sql", sh: "bash", ts: "typescript", tsx: "tsx", yaml: "yaml", yml: "yaml",
    };
    return extension ? languages[extension] ?? "text" : "text";
  }
  if (!input) return "json";
  try {
    JSON.parse(input);
    return "json";
  } catch {
    return "text";
  }
}

/** Lecture tolérante des résultats structurés renvoyés par Hermes. */
export function parseToolResult(tool: string, result: string): ParsedToolResult | null {
  let value: unknown;
  try {
    value = JSON.parse(result);
  } catch {
    return null;
  }
  const record = (candidate: unknown): Record<string, unknown> | null =>
    candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
      ? candidate as Record<string, unknown>
      : null;
  const text = (candidate: unknown): string | undefined =>
    typeof candidate === "string" ? candidate : candidate === null || candidate === undefined ? undefined : String(candidate);
  const object = record(value);
  if (tool.replace(/^mcp__.+?__/, "") === "web_extract") {
    const list = Array.isArray(value) ? value : Array.isArray(object?.results) ? object.results : [];
    const webResults = list.flatMap((item) => {
      const row = record(item);
      if (!row || typeof row.url !== "string") return [];
      return [{
        url: row.url,
        ...(typeof row.title === "string" ? { title: row.title } : {}),
        ...(typeof row.error === "string" ? { error: row.error } : {}),
      }];
    });
    return webResults.length > 0 ? { webResults } : null;
  }
  if (!object) return null;
  const exitCode = typeof object.exit_code === "number" ? object.exit_code
    : typeof object.exitCode === "number" ? object.exitCode : undefined;
  const durationSeconds = typeof object.duration_seconds === "number" ? object.duration_seconds : undefined;
  const toolCallsMade = typeof object.tool_calls_made === "number" ? object.tool_calls_made : undefined;
  const parsed: ParsedToolResult = {
    ...(typeof object.status === "string" ? { status: object.status } : {}),
    ...(text(object.output) !== undefined ? { output: text(object.output) } : {}),
    ...(text(object.error) !== undefined ? { error: text(object.error) } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(toolCallsMade !== undefined ? { toolCallsMade } : {}),
  };
  return Object.keys(parsed).length > 0 ? parsed : null;
}
