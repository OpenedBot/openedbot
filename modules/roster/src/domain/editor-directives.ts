import type { BotPermissionMode, BotReplyLanguage } from "@openedbot/contracts-api";
import { approvalPolicyMode, permissionPipelineOf } from "@openedbot/runtimes/domain/runtime-contract";

export function hostApprovalPolicyProven(input: {
  linkFeatures: readonly string[];
  managedProfile: boolean;
  permissionMode: BotPermissionMode | string | null;
  permissionPipeline: string | null;
  policyMode: string | null;
  effectiveAt: Date | string | null;
}): boolean {
  return input.linkFeatures.includes("approval_policy")
    && input.managedProfile
    && input.permissionMode !== null
    && input.policyMode === approvalPolicyMode(input.permissionMode as BotPermissionMode, permissionPipelineOf(input.permissionPipeline))
    && input.effectiveAt !== null;
}

const LANGUAGE_NAMES: Record<Exclude<BotReplyLanguage, "auto">, string> = {
  en: "English",
  fr: "French",
  es: "Spanish",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  ja: "Japanese",
  tr: "Turkish",
};

/**
 * The agent editor's run-time directives: the reply language and the `plan`
 * permission mode. Appended to the persona like the team brief, so they sit
 * in the stable, cacheable prompt prefix. Empty when nothing is set.
 *
 * `auto` / `bypass` / `manual` add nothing here: they are an approval policy
 * enforced by the worker, not a request to the model.
 */
export function buildEditorDirectivesBlock(settings: {
  label?: string | null;
  replyLanguage?: BotReplyLanguage | string | null;
  permissionMode?: BotPermissionMode | string | null;
  /**
   * L'hôte soumet lui-même les outils d'écriture à l'accord de l'opérateur
   * (capacité `approval_policy`). Sans elle, seul le modèle peut tenir la
   * promesse du mode manuel ; avec elle, la consigne ferait demander deux fois.
   */
  hostEnforcesApprovals?: boolean;
  /** PERM2-1: under `v2` the host submits every write and the pipeline answers. */
  permissionPipeline?: string | null;
}): string {
  const lines: string[] = [];
  const label = settings.label?.trim().slice(0, 60);
  if (label) lines.push(`- Your role on this team: ${label}.`);
  const language = settings.replyLanguage && settings.replyLanguage !== "auto"
    ? LANGUAGE_NAMES[settings.replyLanguage as Exclude<BotReplyLanguage, "auto">]
    : undefined;
  if (language) {
    lines.push(`- Always reply in ${language}, whatever language the operator writes in.`);
  }
  const pipelineAnswers = settings.permissionPipeline === "v2" && settings.hostEnforcesApprovals === true;
  if (settings.permissionMode === "auto" && pipelineAnswers) {
    lines.push(
      "- Auto mode: act without asking for confirmation. Your risky actions are checked before they run, by the operator or a policy.",
    );
  } else if (settings.permissionMode === "auto") {
    lines.push(
      "- Auto mode: act without asking for confirmation, but stop and ask the operator before anything irreversible (deleting data, payments, messages sent to third parties).",
    );
  }
  if (pipelineAnswers && (settings.permissionMode === "auto" || settings.permissionMode === "bypass")) {
    lines.push(
      "- If an action is refused, do not try it again, nor the same effect another way: say what was refused and propose something else.",
    );
  }
  if (settings.permissionMode === "manual" && !settings.hostEnforcesApprovals) {
    lines.push(
      "- Manual mode: before any change on the server (writing a file or a skill, a command that modifies something, sending a message), stop and ask with a single `@user <question>` line, then up to 4 options as `- …` lines. Reading and searching need no question.",
      "- An explicit request in the operator's CURRENT message (\"learn…\", \"create the skill\", \"write it\", \"update your persona\") is that approval: do the change in this turn without asking again. An earlier refusal does not cancel a later explicit request.",
    );
  }
  if (settings.permissionMode === "plan") lines.push(...PLAN_MODE_LINES);
  if (!lines.length) return "";
  return ["## Operator settings", "", ...lines].join("\n");
}

const PLAN_MODE_LINES = [
  "- Plan mode: if one missing detail would change the plan, stop and ask with a single `@user <question>` line, then up to 4 options as `- …` lines. Do not write the plan in that reply.",
  "- Otherwise reply with only a numbered plan (`1. …`, one step per line) and a last line that waits for confirmation. Reading and searching are allowed. Do not act, and do not call a tool that changes anything.",
] as const;

/**
 * « Planifier d'abord » on ONE message (0155). It rides at the head of that
 * turn's input, never in the instructions: they are the provider's cached
 * prefix, and flipping them for one message re-wrote the whole prefix twice
 * (on the plan turn, then on the next one). The worker still enforces `plan`.
 */
export function buildPlanTurnBlock(): string {
  return [
    "## This message only: plan first",
    "",
    "- The operator asked for a plan before any action on this message. It overrides the mode in your instructions for this reply only.",
    ...PLAN_MODE_LINES,
  ].join("\n");
}

/** `auto` and `bypass`: the worker may answer the bot's approval requests. */
export function autoApprovesPermission(mode: BotPermissionMode | string | null | undefined): boolean {
  return mode === "auto" || mode === "bypass";
}

/**
 * US-PERM-1 (DEV-240). The worker may reply `once` only when the mode allows
 * it and the command is not held back:
 *
 * - `manual` / `plan` never auto-approve.
 * - `auto` holds every deletion for the operator (file-deletion protection).
 * - every mode, including `bypass`, holds a circuit breaker: deleting `/`,
 *   the home directory itself, the process cwd (`.`, the stand-in for a
 *   workspace root the gate does not name), or touching `.git/config`,
 *   `.git/hooks`, `.ssh`, `.env`, `id_rsa`, `credentials`, the macOS keychain
 *   (`PROTECTED_PATH_PATTERNS`).
 *
 * An interpreter that deletes (`python -c`, `find -exec`) is not classified
 * here. The gate text is the shell Hermes asked about, not a semantic model.
 */
export function workerMayApproveGate(
  mode: BotPermissionMode | string | null | undefined,
  command: string | null | undefined,
): boolean {
  if (!autoApprovesPermission(mode)) return false;
  const text = command ?? "";
  if (isCircuitBreaker(text)) return false;
  if (mode === "auto" && isDeletion(text)) return false;
  return true;
}

/** The US-PERM-1 circuit breaker on a shell command, for the PERM2 pipeline. */
export function commandHitsCircuitBreaker(command: string): boolean {
  return isCircuitBreaker(command);
}

/** A shell command that deletes (`rm`, `find -delete`, `git clean`...). */
export function commandDeletes(command: string): boolean {
  return isDeletion(command);
}

/** A path the circuit breaker never lets a policy touch: `/`, home, `.`, `.ssh`, `.env`... */
export function isSensitivePath(path: string): boolean {
  return isFilesystemRoot(path) || isHomeItself(path) || isWorkspaceDot(path) || isProtectedPath(path);
}

/** Shell-like words, quotes honored; `null` when a quote never closes. */
export function shellWords(input: string): string[] | null {
  let open = false;
  let quote: string | null = null;
  for (const char of input) {
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"') {
      quote = char;
    }
    open = quote !== null;
  }
  return open ? null : tokenize(input);
}

function isCircuitBreaker(command: string): boolean {
  return scanCommand(command, (hit) => hit.circuit);
}

function isDeletion(command: string): boolean {
  return scanCommand(command, (hit) => hit.deletion);
}

function scanCommand(command: string, pick: (hit: { circuit: boolean; deletion: boolean }) => boolean): boolean {
  for (const segment of command.split(/\s*(?:&&|\|\||[;\n|]|\$\(|`)\s*/)) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const tokens = tokenize(trimmed);
    let index = 0;
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index += 1;
    if (tokens[index] === "sudo" || tokens[index] === "command") index += 1;
    const rawName = tokens[index];
    if (!rawName) continue;
    const name = rawName.split("/").pop() ?? rawName;
    const args = tokens.slice(index + 1);
    if (pick(classifySegment(name, args, trimmed))) return true;
  }
  return false;
}

function classifySegment(name: string, args: string[], raw: string): { circuit: boolean; deletion: boolean } {
  if (name === "rm" || name === "rmdir" || name === "unlink" || name === "shred") {
    const paths = operandPaths(args);
    return {
      deletion: paths.length > 0,
      circuit: paths.some((path) => isFilesystemRoot(path) || isHomeItself(path) || isWorkspaceDot(path) || isProtectedPath(path)),
    };
  }
  if (name === "find" && (args.includes("-delete") || args.includes("-exec"))) {
    const paths = args.filter((arg) => !arg.startsWith("-"));
    return {
      deletion: true,
      circuit: paths.some((path) => isFilesystemRoot(path) || isHomeItself(path) || isWorkspaceDot(path)),
    };
  }
  if (name === "git" && args.includes("clean")) return { deletion: true, circuit: false };
  if (name === "tee" || name === "cp" || name === "mv" || name === "install") {
    return { deletion: false, circuit: args.some((arg) => isProtectedPath(arg)) };
  }
  return { deletion: false, circuit: redirectsToProtected(raw) };
}

function operandPaths(args: readonly string[]): string[] {
  const paths: string[] = [];
  let flags = true;
  for (const arg of args) {
    if (flags && arg === "--") {
      flags = false;
      continue;
    }
    if (flags && arg.startsWith("-") && arg !== "-") continue;
    flags = false;
    paths.push(arg);
  }
  return paths;
}

function isFilesystemRoot(path: string): boolean {
  return path === "/" || path === "/*" || path === "/**" || path === "/." || path === "//";
}

function isHomeItself(path: string): boolean {
  const bare = path.replace(/\/+$/, "");
  return bare === "~" || bare === "$HOME" || bare === "${HOME}";
}

function isWorkspaceDot(path: string): boolean {
  return path === "." || path === "./" || path === "./*";
}

/**
 * The paths no policy ever lets a bot touch, by protection id. The circuit
 * breaker and the floor read them in every mode; a YOLO lease names the ids
 * it keeps (`protect`), and the shared fixture `yolo-hardline.json` holds the
 * same patterns for the host. The macOS keychain joined the original six.
 */
export const PROTECTED_PATH_PATTERNS = {
  git_config: /(?:^|\/)\.git\/config$/,
  git_hooks: /(?:^|\/)\.git\/hooks(?:\/|$)/,
  ssh: /(?:^|\/)\.ssh(?:\/|$)/,
  // `.env` and its variants (`.env.local`, `.env.production`...), never `.envrc`.
  env: /(?:^|\/)\.env(?:\.[A-Za-z0-9_.-]+)?$/,
  id_rsa: /(?:^|\/)id_rsa$/,
  credentials: /(?:^|\/)credentials(?:\.json)?$/,
  keychain: /(?:^|\/)Library\/Keychains(?:\/|$)/,
} as const satisfies Record<string, RegExp>;

export type ProtectedPathId = keyof typeof PROTECTED_PATH_PATTERNS;

const PROTECTED_PATHS: readonly RegExp[] = Object.values(PROTECTED_PATH_PATTERNS);

function isProtectedPath(path: string): boolean {
  return PROTECTED_PATHS.some((pattern) => pattern.test(path));
}

function redirectsToProtected(raw: string): boolean {
  return /(?:>>?)\s*['"]?(?:\.git\/config|\.git\/hooks|\.ssh(?:\/|$)|(?:^|[\s/'"])\.env\b|id_rsa|credentials(?:\.json)?)/.test(raw);
}

function tokenize(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (const char of input) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === " " || char === "\t") {
      if (current) out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) out.push(current);
  return out;
}
