/**
 * Ce qu'un bail YOLO n'auto-approuve JAMAIS :
 *
 *   - la liste hardline : ce qui casse l'hôte (effacer `/` ou le home,
 *     formater un disque, l'éteindre...) et ce qui élargirait le bail
 *     lui-même (SOUL.md, la config Hermes, le plugin d'approbation, l'état
 *     YOLO de l'hôte) ;
 *   - la deny-list d'organisation que porte le bail (commandes, outils,
 *     chemins) ;
 *   - les protections (`protect`) : les chemins de `PROTECTED_PATH_PATTERNS`
 *     et les commandes qui les visent, trousseau macOS compris.
 *
 * Données plutôt que code : les mêmes motifs sont dans le fixture partagé
 * `yolo-hardline.json` (copie edge-setup `test/golden/yolo-hardline/`), que
 * l'hôte consommera en Go (auto-répondeur) et en Python (plugin). Un test
 * tient ce module égal au fixture. Les expressions restent dans le
 * sous-ensemble commun à RE2, Python et JavaScript (ni lookaround ni
 * référence arrière). La liste reste à confronter à la liste « même en
 * `--yolo` » de Hermes amont (spike de la PR 3) : elle ne peut que grandir.
 */

import type { YoloLeaseDenyList } from "@openedbot/contracts-connector";
import { PROTECTED_PATH_PATTERNS, type ProtectedPathId } from "@openedbot/roster/domain/editor-directives";
import { commandMatchesBlocklist } from "./command-blocklist";

export type YoloRule = { id: string; pattern: string };

/** Début d'une commande : début de ligne, après un séparateur ou `sudo`, variables d'environnement passées. */
const AT_COMMAND = String.raw`(?:^\s*|[;&|(\x60]\s*|\bsudo\s+)(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|]*\s+)*`;
/** Fin d'un mot de commande. */
const WORD_END = String.raw`(?:\s|[;&|)]|$)`;
/** Un mot (option ou opérande) qui ne franchit pas un séparateur. */
const ANY_WORDS = String.raw`(?:[^\s;&|]+\s+)*`;
const BLOCK_DEVICE = String.raw`/dev/(?:sd|hd|vd|xvd|nvme|disk|rdisk|mmcblk)`;

export const YOLO_HARDLINE: { tools: readonly string[]; paths: readonly YoloRule[]; commands: readonly YoloRule[] } = {
  tools: ["cronjob"],
  paths: [
    { id: "soul", pattern: String.raw`(?:^|/)SOUL\.md$` },
    { id: "hermes_config", pattern: String.raw`(?:^|/)\.hermes/(?:profiles/[^/]+/)?config\.yaml$` },
    { id: "approval_plugin", pattern: String.raw`(?:^|/)plugins/ohb_approval_policy(?:/|$)` },
    { id: "yolo_state", pattern: String.raw`(?:^|/)yolo(?:-[a-z]+)?\.jsonl?$` },
  ],
  commands: [
    { id: "rm_root_or_home", pattern: `${AT_COMMAND}rm\\s+${ANY_WORDS}['"]?(?:/|/\\*|~|~/|~/\\*|\\$HOME|\\$\\{HOME\\}|\\$HOME/\\*|\\$\\{HOME\\}/\\*)['"]?${WORD_END}` },
    { id: "mkfs", pattern: `${AT_COMMAND}mkfs(?:\\.[A-Za-z0-9]+)?(?:\\s|$)` },
    { id: "dd_device", pattern: `${AT_COMMAND}dd\\s+${ANY_WORDS}of=${BLOCK_DEVICE}` },
    { id: "redirect_device", pattern: `>\\s*${BLOCK_DEVICE}` },
    { id: "fork_bomb", pattern: String.raw`:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:` },
    { id: "power", pattern: `${AT_COMMAND}(?:shutdown|reboot|halt|poweroff|systemctl\\s+(?:poweroff|reboot|halt|kexec)|init\\s+[06])${WORD_END}` },
    { id: "perms_root", pattern: `${AT_COMMAND}(?:chmod|chown|chgrp)\\s+${ANY_WORDS}['"]?/['"]?${WORD_END}` },
    { id: "kill_all", pattern: `${AT_COMMAND}kill\\s+${ANY_WORDS}-1\\s*(?:[;&|)]|$)` },
  ],
};

/** Une commande qui nomme le chemin protégé `name` comme mot entier. */
function mentions(name: string): string {
  return `(?:^|[\\s'"=:<>/])${name}(?:[\\s'"/;&|<>)]|$)`;
}

/** Le catalogue des protections : chaque id couvre un motif de `PROTECTED_PATH_PATTERNS` et les commandes qui le visent. */
export const YOLO_PROTECTIONS: Readonly<Record<ProtectedPathId, { paths: readonly string[]; commands: readonly string[] }>> = {
  git_config: { paths: [String.raw`(?:^|/)\.git/config$`], commands: [mentions(String.raw`\.git/config`)] },
  git_hooks: { paths: [String.raw`(?:^|/)\.git/hooks(?:/|$)`], commands: [mentions(String.raw`\.git/hooks`)] },
  ssh: { paths: [String.raw`(?:^|/)\.ssh(?:/|$)`], commands: [mentions(String.raw`\.ssh`)] },
  env: { paths: [String.raw`(?:^|/)\.env$`], commands: [mentions(String.raw`\.env`)] },
  id_rsa: { paths: [String.raw`(?:^|/)id_rsa$`], commands: [mentions("id_rsa")] },
  credentials: { paths: [String.raw`(?:^|/)credentials(?:\.json)?$`], commands: [mentions(String.raw`credentials(?:\.json)?`)] },
  keychain: {
    paths: [String.raw`(?:^|/)Library/Keychains(?:/|$)`],
    commands: [
      mentions("Library/Keychains"),
      `${AT_COMMAND}security\\s+(?:find-[a-z]+-password|dump-keychain|export)${WORD_END}`,
    ],
  },
};

/** Toutes les protections, dans l'ordre du catalogue : le `protect` d'un bail les contient toujours. */
export const YOLO_DEFAULT_PROTECT: readonly ProtectedPathId[] = Object.keys(PROTECTED_PATH_PATTERNS) as ProtectedPathId[];

export function isYoloProtectionId(id: string): id is ProtectedPathId {
  return Object.hasOwn(YOLO_PROTECTIONS, id);
}

/** Ce qu'une porte expose aux contrôles YOLO : l'outil, les chemins que le descripteur nomme, la commande d'un terminal. */
export type YoloGateSubject = { toolKey: string | null; paths: readonly string[]; command: string | null };

const compile = (pattern: string): RegExp => new RegExp(pattern);
const HARDLINE_PATHS = YOLO_HARDLINE.paths.map((rule) => ({ id: rule.id, regex: compile(rule.pattern) }));
const HARDLINE_COMMANDS = YOLO_HARDLINE.commands.map((rule) => ({ id: rule.id, regex: compile(rule.pattern) }));
const PROTECTIONS = new Map(Object.entries(YOLO_PROTECTIONS).map(([id, rules]) => [id, {
  paths: rules.paths.map(compile),
  commands: rules.commands.map(compile),
}]));

/** L'id de la règle hardline que touche la porte ; `null` : aucune. */
export function yoloHardlineHit(subject: YoloGateSubject): string | null {
  if (subject.toolKey && YOLO_HARDLINE.tools.includes(subject.toolKey)) return `tool:${subject.toolKey}`;
  for (const rule of HARDLINE_PATHS) if (subject.paths.some((path) => rule.regex.test(path))) return rule.id;
  if (subject.command !== null) for (const rule of HARDLINE_COMMANDS) if (rule.regex.test(subject.command)) return rule.id;
  return null;
}

/**
 * L'id de la protection que touche la porte, parmi `protect` et les
 * protections par défaut (toujours tenues). Un id que ce code ne connaît pas
 * ne protège rien ici : le bail qui le porte est refusé à la validation.
 */
export function yoloProtectionHit(subject: YoloGateSubject, protect: readonly string[]): string | null {
  for (const id of new Set([...YOLO_DEFAULT_PROTECT, ...protect])) {
    const rules = PROTECTIONS.get(id);
    if (!rules) continue;
    if (subject.paths.some((path) => rules.paths.some((regex) => regex.test(path)))) return id;
    if (subject.command !== null && rules.commands.some((regex) => regex.test(subject.command!))) return id;
  }
  return null;
}

function trimSlashes(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/**
 * Un chemin de la deny-list vise ce chemin s'il l'est, s'il le contient
 * (`/srv/data` vise `/srv/data/x`) ou s'il en est une suite de composants
 * entiers (`.aws` vise `~/.aws/config`). Jamais une sous-chaîne : `.aws` ne
 * vise pas `my.aws.txt`.
 */
export function denyPathMatches(path: string, entry: string): boolean {
  const target = trimSlashes(path);
  const denied = trimSlashes(entry);
  if (!denied) return false;
  if (target === denied || target.startsWith(denied === "/" ? "/" : `${denied}/`)) return true;
  const padded = `/${target}/`;
  return padded.includes(`/${denied.replace(/^\/+/, "")}/`);
}

/**
 * La deny-list d'organisation portée par le bail : `true` touchée, `false`
 * non, `null` la commande ne se lit pas alors qu'une liste de commandes
 * existe (refusée, comme la liste de blocage de l'étape 1).
 */
export function yoloDenyListHit(subject: YoloGateSubject, deny: YoloLeaseDenyList): boolean | null {
  if (subject.toolKey && deny.tools.includes(subject.toolKey)) return true;
  if (subject.paths.some((path) => deny.paths.some((entry) => denyPathMatches(path, entry)))) return true;
  if (subject.command !== null && deny.commands.length > 0) return commandMatchesBlocklist(subject.command, deny.commands);
  return false;
}
