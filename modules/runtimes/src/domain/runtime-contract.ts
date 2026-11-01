/**
 * Ce que le runtime d'un client DOIT respecter, et ce que l'application fait
 * quand il ne le respecte pas.
 *
 * openedbot n'administre pas le runtime Hermes d'un client (`CLAUDE.md`) :
 * la configuration reste chez lui. L'application n'a donc pas le droit de
 * SUPPOSER une configuration correcte : le défaut d'usine du runtime ne l'est
 * pas. Mesuré le 2026-08-26 sur hermes-agent 0.20.5 : `delegation`, `memory` et
 * `session_search` sont actifs par défaut, une restriction d'outils au niveau
 * du run est ignorée, et `admin_config_rw: false` ferme toute écriture par API.
 *
 * D'où deux niveaux, et deux seulement :
 *   - l'INVENTAIRE (`FORBIDDEN_TOOLSETS`) : ce qu'on lit dans `/v1/toolsets`
 *     avant tout run, pour le dire à l'opérateur ;
 *   - l'USAGE (`UNTRACKED_BACKGROUND_TOOLS`) : ce qu'on constate dans les
 *     événements d'un run terminé, pour que le fil ne mente pas.
 *
 * Le second existe parce que le premier ne suffit pas : un avertissement se
 * range, une consigne de prompt s'ignore, et il reste un fil qui affiche une
 * réponse confiante au-dessus d'un travail que personne ne suit.
 *
 * Depuis ADR_BOT_PROFILE, `memory` et `session_search` ne sont plus un
 * stockage partagé : un bot à profil cloisonné (`scope: "profile"`) a son
 * propre `HERMES_HOME`. Ils restent interdits sur le profil racine
 * (`scope: "runtime"`), qui est encore le jeu que `FORBIDDEN_TOOLSETS`
 * expose aux appelants non migrés.
 */

/**
 * Seconds ordonnanceurs : interdits partout, profil nommé ou racine.
 *
 * `delegation` fournit `delegate_task` : un second ordonnanceur, en mémoire,
 * dont l'exécution de fond ne survit pas à un redémarrage et dont les erreurs
 * différées n'apparaissent pas toutes dans `/v1/runs`
 * (`docs/cloud/MULTI_BOT.md`). Le hand-off `@slug` d'openedbot le remplace
 * et n'en dépend pas (vérifié le 26-08, il continue de fonctionner une fois
 * `delegate_task` retiré).
 *
 * `cronjob` persiste une tâche et la rejoue hors du run, de son lease, de son
 * budget et de son journal openedbot. Le runtime épinglé n'expose plus
 * `send_message` au modèle, mais un runtime ancien ou divergent peut encore
 * l'annoncer sous un autre toolset : le garde par NOM D'OUTIL ci-dessous le
 * refuse également avant le run.
 */
export const ALWAYS_FORBIDDEN_TOOLSETS: ReadonlySet<string> = new Set([
  "cronjob",
  "delegation",
]);

/**
 * Stockage mémoire côté runtime. Autorisé seulement sur un profil cloisonné
 * dont l'isolation est prouvée (`scope: "profile"`). Sur la racine, tous les bots
 * partageraient le même `HERMES_HOME` : c'était la raison du refus.
 */
export const PROFILE_RESTRICTED_TOOLSETS: ReadonlySet<string> = new Set([
  "memory",
  "session_search",
]);

/**
 * Jeu `runtime` : toujours interdits plus les toolsets réservés au profil.
 *
 * Les appelants non migrés (enregistrement du runtime, seed, doctor hôte)
 * inspectent la racine ; ce jeu-là reste le leur. Un run ou une bascule
 * `scope: "profile"` passe par `runtimeToolsetContractViolation(..., { scope })`.
 */
export const FORBIDDEN_TOOLSETS: ReadonlySet<string> = new Set([
  ...ALWAYS_FORBIDDEN_TOOLSETS,
  ...PROFILE_RESTRICTED_TOOLSETS,
]);

/**
 * The toolsets a NEW bot's profile starts with, so that it can act at once
 * like a Grok Bot bot (operator, 2026-10-25: "le bot doit être opérationnel
 * comme dans grokbot"). Every one is on by default at a competitor
 * (hermes-agent's own `hermes-api-server` composite, OpenClaw `coding`,
 * touri, OpenMausBot; study of 2026-10-25). A profile clones the
 * runtime root, whose list drifts: the worker's capability baseline
 * (`modules/roster/src/domain/capability-baseline.ts`) applies this set to
 * each new bot's profile.
 *
 * Safety is the permission pipeline (gates, reviewer, floors), not tools left
 * off. `memory` and `session_search` are allowed here because a bot profile
 * is isolated (`scope: "profile"`); `cronjob` and `delegation` stay forbidden
 * by contract and are filtered out whatever this list says.
 */
export const DEFAULT_BOT_TOOLSETS: readonly string[] = [
  "web", "terminal", "file", "code_execution", "browser", "vision", "image_gen", "todo", "skills", "memory", "session_search",
].filter((name) => !ALWAYS_FORBIDDEN_TOOLSETS.has(name));

/** Portée du contrat d'outils : profil nommé cloisonné, ou racine partagée. */
export type RuntimeToolsetScope = "profile" | "runtime";

export type RuntimeToolsetContractOptions = {
  scope?: RuntimeToolsetScope;
};

/**
 * Effets persistants/mutants qui contournent la persistence et l'audit openedbot.
 *
 * La vérification porte aussi sur `tools`, et non uniquement sur le nom du
 * toolset : `send_message` a historiquement changé de surface upstream et un
 * plugin/MCP peut le republier sous un nom de toolset différent.
 */
export const FORBIDDEN_RUNTIME_TOOLS: ReadonlySet<string> = new Set([
  "cronjob",
  "cronjob_manage",
  "send_message",
  // `delegation`'s tool, refused by name too should another toolset carry it.
  "delegate_task",
]);

export const APPROVAL_POLICY_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "write_file", "patch", "skill_manage", "execute_code", "send_message", "cronjob",
]);
export const APPROVAL_POLICY_FEATURE = "approval_policy";
export function isApprovalPolicyWriteTool(name: string): boolean {
  return APPROVAL_POLICY_WRITE_TOOLS.has(name) || name.startsWith("mcp_");
}
/** PERM2-7a: the tool-less profile the automatic review runs on. */
export const REVIEW_PROFILE = "ohb-reviewer";
/**
 * Profiles openedbot creates on the host for its own checks: never a bot's slug,
 * never listed for import, never imported.
 */
export const OPENEDBOT_SERVICE_PROFILES: ReadonlySet<string> = new Set(["ohb-model-check", REVIEW_PROFILE]);
/** The link features the review profile needs: create it, cut its tools, set its plugin. */
export const REVIEW_PROFILE_FEATURES = ["profile_management", "profile_capabilities", APPROVAL_POLICY_FEATURE] as const;
/** Who answers an organization's gates (PERM2-1, `organizations.permission_pipeline`). */
export type PermissionPipelineId = "legacy" | "v2";

export function permissionPipelineOf(value: unknown): PermissionPipelineId {
  return value === "v2" ? "v2" : "legacy";
}

/**
 * The host plugin mode a bot's permission mode needs. Under `v2` every write
 * of `auto` and `bypass` must raise a gate too: the pipeline answers it, and
 * its floor (sensitive paths, deletions, opaque operations) only holds for a
 * write the host submits.
 */
export function approvalPolicyMode(permissionMode: "manual" | "plan" | "auto" | "bypass", pipeline: PermissionPipelineId) {
  if (permissionMode === "plan") return "block_writes" as const;
  return permissionMode === "manual" || pipeline === "v2" ? "ask_writes" as const : "off" as const;
}

export type RuntimeToolsetContractViolation =
  | { code: "HERMES_TOOLSET_INVENTORY_REQUIRED"; toolsets: [] }
  | { code: "HERMES_FORBIDDEN_TOOLSETS_ACTIVE"; toolsets: string[] };

/**
 * Gate fail-closed partagé par l'onboarding et le worker. Une consigne de
 * prompt n'est pas une frontière : si l'inventaire est absent ou si un second
 * ordonnanceur est actif, aucun run openedbot ne doit démarrer. `memory` /
 * `session_search` ne bloquent un run que hors d'un profil cloisonné.
 */
export function runtimeToolsetContractViolation(
  toolsets: readonly { name: string; enabled: boolean; tools?: readonly string[] }[] | null,
  options: RuntimeToolsetContractOptions = {},
): RuntimeToolsetContractViolation | null {
  if (toolsets === null) return { code: "HERMES_TOOLSET_INVENTORY_REQUIRED", toolsets: [] };
  const forbidden = toolsets
    .filter((toolset) => runtimeToolsetIsForbidden(toolset, options))
    .map((toolset) => toolset.name.trim())
    .sort();
  return forbidden.length
    ? { code: "HERMES_FORBIDDEN_TOOLSETS_ACTIVE", toolsets: forbidden }
    : null;
}

/**
 * Un nom de toolset que le contrat refuse d'activer, selon la portée.
 * Distinct de `runtimeToolsetIsForbidden` : l'écran désactive la bascule
 * d'un nom interdit même quand le toolset est déjà coupé.
 */
export function runtimeToolsetNameIsContractForbidden(
  name: string,
  options: RuntimeToolsetContractOptions = {},
): boolean {
  const normalized = normalizedRuntimeName(name);
  if (ALWAYS_FORBIDDEN_TOOLSETS.has(normalized)) return true;
  if ((options.scope ?? "runtime") === "profile") return false;
  return PROFILE_RESTRICTED_TOOLSETS.has(normalized);
}

/** Source partagée entre la gate worker/API et l'avertissement Capacités. */
export function runtimeToolsetIsForbidden(
  toolset: {
    name: string;
    enabled: boolean;
    tools?: readonly string[];
  },
  options: RuntimeToolsetContractOptions = {},
): boolean {
  return toolset.enabled && (
    runtimeToolsetNameIsContractForbidden(toolset.name, options) ||
    toolset.tools?.some((tool) => FORBIDDEN_RUNTIME_TOOLS.has(normalizedRuntimeName(tool))) === true
  );
}

function normalizedRuntimeName(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Les outils dont l'appel lance un travail que la plateforme NE SUIT PAS.
 *
 * Hermes les lance, personne (ni openedbot ni le courrier de hand-off)
 * n'en suivra jamais le résultat. Un run qui les appelle rend une réponse,
 * souvent une promesse de revenir, pendant que le vrai travail continue hors
 * de tout `run_id`, de tout budget et de toute reprise.
 *
 * Ici et non dans le worker (leur place jusqu'au 2026-08-26) : le panneau
 * Capacités doit signaler le TOOLSET qui les fournit avant qu'un run les
 * appelle, et le worker doit détecter l'appel après. Deux listes séparées
 * auraient fini par diverger : l'écran signalant ce que le worker ne détecte
 * plus, ou l'inverse.
 *
 * `detectFireAndForget` et `delegatedHandoffNotice` restent côté worker : ils
 * décrivent ce qu'on FAIT de la détection, pas ce qui est interdit.
 */
export const UNTRACKED_BACKGROUND_TOOLS: ReadonlySet<string> = new Set([
  "delegate_task",
  "async_delegation",
  "subagent",
]);

/**
 * Ce que l'opérateur lit quand la gate refuse, et ce qu'il doit faire ensuite.
 *
 * Trois appelants (l'enregistrement du runtime, le test, la création d'une
 * variante) plus le worker écrivaient chacun leur phrase. L'une d'elles taisait
 * même le nom du toolset fautif, et AUCUNE ne disait quoi corriger : l'écran
 * s'arrêtait sur un constat, alors que la correction tient en une clé de
 * configuration. Le panneau Capacités, lui, la nommait déjà : deux textes pour
 * un même refus, dont un seul actionnable.
 *
 * La correction est côté Hermes par construction : openedbot n'administre
 * pas le runtime d'un client (`CLAUDE.md`), il ne peut donc que nommer la clé.
 */
export function runtimeToolsetContractMessage(violation: RuntimeToolsetContractViolation): string {
  if (violation.code === "HERMES_TOOLSET_INVENTORY_REQUIRED") {
    return "Le runtime Hermes n’expose pas son inventaire d’outils (GET /v1/toolsets). "
      + "Sans cette lecture, openedbot ne peut pas vérifier son contrat d’outils et ne démarre aucun run.";
  }
  return `Le runtime Hermes ne respecte pas le contrat d’outils openedbot : ${violation.toolsets.join(", ")}. `
    + "Ces toolsets exécutent un travail hors du run openedbot (sans lease, sans budget et sans journal). "
    + "Désactivez-les côté Hermes dans « platform_toolsets.api_server » de son config.yaml, puis relancez la vérification.";
}
