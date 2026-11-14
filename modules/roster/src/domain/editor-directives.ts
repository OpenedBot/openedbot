import type { BotPermissionMode, BotReplyLanguage } from "@openedbot/contracts-api";
import { approvalPolicyMode, permissionPipelineOf } from "@openedbot/runtimes/domain/runtime-contract";
import { RELAY_FEATURE_APPROVAL_POLICY } from "@openedbot/contracts-connector/features";

export function hostApprovalPolicyProven(input: {
  linkFeatures: readonly string[];
  managedProfile: boolean;
  permissionMode: BotPermissionMode | string | null;
  permissionPipeline: string | null;
  policyMode: string | null;
  effectiveAt: Date | string | null;
}): boolean {
  return input.linkFeatures.includes(RELAY_FEATURE_APPROVAL_POLICY)
    && input.managedProfile
    && input.permissionMode !== null
    && input.policyMode === approvalPolicyMode(input.permissionMode as BotPermissionMode, permissionPipelineOf(input.permissionPipeline))
    && input.effectiveAt !== null;
}

/**
 * Does a run need the host policy proven before it starts? Always under
 * `v2` (PERM2-2). Under `legacy` only when a stored `auto` is decided as
 * `manual` (no reviewer ready for the organization) on a managed profile
 * whose host can hold the policy: until the reconciliation has hardened it to
 * `ask_writes`, that host would let the writes through without asking anyone.
 */
export function hostApprovalPolicyRequired(input: {
  permissionPipeline: string | null;
  storedPermissionMode: BotPermissionMode | string | null;
  effectivePermissionMode: BotPermissionMode | string | null;
  managedProfile: boolean;
  linkFeatures: readonly string[];
}): boolean {
  if (permissionPipelineOf(input.permissionPipeline) === "v2") return true;
  return input.storedPermissionMode === "auto"
    && input.effectivePermissionMode === "manual"
    && input.managedProfile
    && input.linkFeatures.includes(RELAY_FEATURE_APPROVAL_POLICY);
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
 *   `.git/hooks`, `.ssh`, `.env`, `id_rsa`, `credentials`.
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

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

type WrapperSpec = {
  /** Short options that take a value, attached (`-uroot`) or as the next word. */
  valued: string;
  /** Short options that take none. */
  flags: string;
  /** Short options whose value is attached only (`xargs -i{}`), never the next word. */
  attached?: string;
  longValued?: readonly string[];
  longFlags?: readonly string[];
  /** Operands before the wrapped command (`timeout 5 cmd`). */
  operands?: number;
  /** `nice -5`, `env -`. */
  numeric?: boolean;
  bareDash?: boolean;
};

/**
 * Commands that run the command written after them. Their options are read
 * with their arity: `sudo -u root git push` wraps `git push`, not `root`. An
 * option missing from this table makes the segment unreadable (fail closed),
 * because guessing its arity would let a wrapped command slip past a check.
 */
const WRAPPERS: Readonly<Record<string, WrapperSpec>> = {
  sudo: {
    valued: "CDgpRrTtUu",
    flags: "AbBEeHiKklnPSsVv",
    longValued: ["chdir", "chroot", "close-from", "command-timeout", "group", "host", "other-user", "prompt", "role", "type", "user"],
    longFlags: ["askpass", "background", "bell", "edit", "list", "login", "non-interactive", "preserve-env", "preserve-groups", "remove-timestamp", "reset-timestamp", "set-home", "shell", "stdin", "validate"],
  },
  doas: { valued: "Cu", flags: "Lns" },
  command: { valued: "", flags: "pVv" },
  builtin: { valued: "", flags: "" },
  exec: { valued: "a", flags: "cl" },
  env: {
    valued: "Cu",
    flags: "0iv",
    longValued: ["chdir", "unset"],
    longFlags: ["debug", "ignore-environment", "null"],
    bareDash: true,
  },
  nice: { valued: "n", flags: "", longValued: ["adjustment"], numeric: true },
  nohup: { valued: "", flags: "" },
  timeout: {
    valued: "ks",
    flags: "v",
    longValued: ["kill-after", "signal"],
    longFlags: ["foreground", "preserve-status", "verbose"],
    operands: 1,
  },
  stdbuf: { valued: "eio", flags: "", longValued: ["error", "input", "output"] },
  time: { valued: "fo", flags: "apqv", longValued: ["format", "output"], longFlags: ["append", "portability", "quiet", "verbose"] },
  xargs: {
    valued: "adEILnPs",
    flags: "0oprtx",
    attached: "eil",
    longValued: ["arg-file", "delimiter", "max-args", "max-chars", "max-lines", "max-procs", "process-slot-var"],
    longFlags: ["exit", "interactive", "no-run-if-empty", "null", "open-tty", "show-limits", "verbose"],
  },
};

/** Index past one wrapper's options and operands; `null` on an option it does not know. */
function skipWrapperOptions(words: readonly string[], start: number, spec: WrapperSpec): number | null {
  let index = start;
  while (index < words.length) {
    const word = words[index]!;
    if (word === "--") {
      index += 1;
      break;
    }
    if (word === "-" && spec.bareDash) {
      index += 1;
      continue;
    }
    if (!word.startsWith("-") || word === "-") break;
    if (word.startsWith("--")) {
      const name = word.slice(2).split("=")[0]!;
      const valued = spec.longValued?.includes(name) ?? false;
      if (!valued && !(spec.longFlags?.includes(name) ?? false)) return null;
      index += valued && !word.includes("=") ? 2 : 1;
      continue;
    }
    if (spec.numeric && /^-\d+$/.test(word)) {
      index += 1;
      continue;
    }
    let takesNext = false;
    for (let position = 1; position < word.length; position += 1) {
      const option = word[position]!;
      if (spec.flags.includes(option)) continue;
      if (spec.attached?.includes(option)) break;
      if (!spec.valued.includes(option)) return null;
      takesNext = position === word.length - 1;
      break;
    }
    index += takesNext ? 2 : 1;
  }
  return index + (spec.operands ?? 0);
}

/**
 * Where each command of one shell segment starts: every wrapper (`sudo`,
 * `env`, `timeout`...) and the command it finally runs, past `NAME=value`
 * assignments and the wrappers' options. `sudo -n git push` starts at `sudo`
 * and at `git`. `null`: an option the parser cannot size, the segment is
 * unreadable and the caller must refuse rather than guess.
 */
export function commandStarts(words: readonly string[]): number[] | null {
  const starts: number[] = [];
  let index = 0;
  for (;;) {
    while (index < words.length && ASSIGNMENT.test(words[index] ?? "")) index += 1;
    const word = words[index];
    if (word === undefined) return starts;
    starts.push(index);
    const spec = WRAPPERS[word.split("/").pop() ?? word];
    if (!spec) return starts;
    const next = skipWrapperOptions(words, index + 1, spec);
    if (next === null) return null;
    index = next;
  }
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
    const starts = commandStarts(tokens);
    // A wrapper option the parser cannot size hides the command: held.
    if (starts === null) return true;
    const index = starts.at(-1);
    const rawName = index === undefined ? undefined : tokens[index];
    if (index === undefined || !rawName) continue;
    const name = rawName.split("/").pop() ?? rawName;
    const args = tokens.slice(index + 1);
    const hit = classifySegment(name, args);
    if (pick({ ...hit, circuit: hit.circuit || redirectsToProtected(trimmed) })) return true;
  }
  return false;
}

function classifySegment(name: string, args: string[]): { circuit: boolean; deletion: boolean } {
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
  return { deletion: false, circuit: false };
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

function isProtectedPath(path: string): boolean {
  return /(?:^|\/)\.git\/config$/.test(path)
    || /(?:^|\/)\.git\/hooks(?:\/|$)/.test(path)
    || /(?:^|\/)\.ssh(?:\/|$)/.test(path)
    || /(?:^|\/)\.env$/.test(path)
    || /(?:^|\/)id_rsa$/.test(path)
    || /(?:^|\/)credentials(?:\.json)?$/.test(path);
}

/**
 * A write redirection (`>`, `>>`, `>|`, `&>`, `2>`, `<>`) onto a sensitive
 * path, relative or absolute (`> /workspace/.env`). A redirection whose
 * target cannot be read (missing, cut by `$(`) counts as one. The plain scan
 * ignores quotes on purpose: a segment cut inside a quote by the `$(` split
 * must not hide its redirection.
 */
function redirectsToProtected(raw: string): boolean {
  if (/(?:>>?)\s*['"]?(?:\.git\/config|\.git\/hooks|\.ssh(?:\/|$)|(?:^|[\s/'"])\.env\b|id_rsa|credentials(?:\.json)?)/.test(raw)) {
    return true;
  }
  for (const match of raw.matchAll(/>\s*['"]?([^\s;&|<>()'"]+)/g)) {
    if (isSensitivePath(match[1]!)) return true;
  }
  const targets = redirectionTargets(raw);
  return targets === null || targets.some(isSensitivePath);
}

/** The targets of a segment's write redirections, quotes removed; `null` when one has none. */
function redirectionTargets(raw: string): string[] | null {
  const targets: string[] = [];
  let quote: string | null = null;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char !== ">") continue;
    let cursor = index + 1;
    if (raw[cursor] === ">" || raw[cursor] === "|") cursor += 1;
    // `>&2`, `2>&1`, `>&-` duplicate or close a descriptor: no file.
    const duplicate = raw[cursor] === "&" && /^&(?:\d+|-)(?![^\s;&|<>()])/.test(raw.slice(cursor));
    if (raw[cursor] === "&") cursor += 1;
    while (raw[cursor] === " " || raw[cursor] === "\t") cursor += 1;
    let target = "";
    let targetQuote: string | null = null;
    for (; cursor < raw.length; cursor += 1) {
      const next = raw[cursor]!;
      if (targetQuote) {
        if (next === targetQuote) targetQuote = null;
        else target += next;
        continue;
      }
      if (next === "'" || next === '"') {
        targetQuote = next;
        continue;
      }
      if (/[\s;&|<>()]/.test(next)) break;
      target += next;
    }
    if (targetQuote || !target) return null;
    if (!duplicate) targets.push(target);
    index = cursor - 1;
  }
  return targets;
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
