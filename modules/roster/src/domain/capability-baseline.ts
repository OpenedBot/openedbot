import {
  DEFAULT_BOT_TOOLSETS,
  PROFILE_RESTRICTED_TOOLSETS,
  approvalPolicyMode,
  permissionPipelineOf,
  runtimeToolsetNameIsContractForbidden,
} from "@openedbot/runtimes/domain/runtime-contract";
import type { BotPermissionMode } from "@openedbot/contracts-api";
import { PROFILE_CAPABILITIES_FEATURE } from "./bot-capabilities";

/**
 * Socle « bot léger » (DEV-OHB-247) : version courante. Un bot dont
 * `bots.capability_baseline_version` est plus bas reçoit le socle du worker,
 * qui n'estampille la version qu'une fois toutes les écritures relues.
 * Incrémenter cette constante rejoue le socle partout.
 *
 * Version 2 (operator, 2026-10-25): bots stamped at 1 receive the tools a new
 * bot gets (`baselineEnabledToolsets`). The replay is additive: it turns on
 * what is missing and leaves the rest, toolsets and skills the operator set
 * since, as they are (`baselineToolsetPlan` with `additive`).
 */
export const CAPABILITY_BASELINE_VERSION = 2;

/**
 * The light set (DEV-OHB-247), kept only for a runtime that does not hold the
 * approval policy: there, file, code and browser would act without a gate.
 * `skills` stays: it is how a bot learns.
 */
export const BASELINE_ENABLED_TOOLSETS: readonly string[] = ["web", "terminal", "skills"];

/**
 * Where a bot stands for the baseline: `gated` when its host policy is proven
 * effective in a mode that raises a gate (`ask_writes`, `block_writes`);
 * `ungated` when its mode wants no host gate (`off`: `auto` or `bypass` under
 * the legacy pipeline), which keeps the light set; `pending` while the
 * runtime holds the policy but has not proven it lately: the baseline waits
 * rather than stamp the light set for good. A proof older than
 * `BASELINE_GATE_PROOF_MAX_AGE_MS` (the approval policy reconciliation's
 * recheck period) may no longer match the host.
 */
export const BASELINE_GATE_PROOF_MAX_AGE_MS = 10 * 60_000;

export function baselineGate(bot: {
  hostHoldsPolicy: boolean;
  permissionMode: BotPermissionMode;
  pipeline: unknown;
  approvalPolicyMode: string | null;
  approvalPolicyEffectiveAt: Date | null;
}, nowMs: number): "gated" | "ungated" | "pending" {
  if (!bot.hostHoldsPolicy) return "ungated";
  const wanted = approvalPolicyMode(bot.permissionMode, permissionPipelineOf(bot.pipeline));
  if (wanted === "off") return "ungated";
  const proof = bot.approvalPolicyEffectiveAt;
  const fresh = proof !== null && nowMs - proof.getTime() < BASELINE_GATE_PROOF_MAX_AGE_MS;
  return bot.approvalPolicyMode === wanted && fresh ? "gated" : "pending";
}

/**
 * What the baseline turns on (operator, 2026-10-25: a new bot must act at
 * once, like a Grok Bot bot). Behind the approval policy (`gated`), a bot gets
 * `DEFAULT_BOT_TOOLSETS`; the profile-only stores (`memory`,
 * `session_search`) only on a profile whose isolation is proven.
 */
export function baselineEnabledToolsets(options: { gated: boolean; isolated: boolean }): readonly string[] {
  if (!options.gated) return BASELINE_ENABLED_TOOLSETS;
  return DEFAULT_BOT_TOOLSETS.filter((name) => options.isolated || !PROFILE_RESTRICTED_TOOLSETS.has(name));
}

/** `POST /hermes-setup/profiles/{slug}/bundled-skills` : les skills livrées avec Hermes, en bloc. */
export const PROFILE_BUNDLED_SKILLS_FEATURE = "profile_bundled_skills";

/** Les verbes hôte dont le socle a besoin, tous deux annoncés par le runtime. */
export const BASELINE_REQUIRED_FEATURES: readonly string[] = [
  PROFILE_CAPABILITIES_FEATURE,
  PROFILE_BUNDLED_SKILLS_FEATURE,
];

export type BaselineToolsetWrite = { name: string; enabled: boolean };

/**
 * The plan for one profile: the writes, and the wanted toolsets the host
 * cannot set (`unavailable`), named instead of silently dropped. A missing
 * `required` one (the light set) blocks the stamp; any other is logged and
 * stamped, since this Hermes has nothing to turn on.
 */
export type BaselineToolsetPlan = { writes: BaselineToolsetWrite[]; unavailable: string[]; required: string[] };

/**
 * Les écritures qui amènent l'inventaire de toolsets d'un profil au socle.
 * Pur : un toolset hors socle n'est éteint que s'il est listé actif, un nom du
 * socle absent ou éteint est allumé, un nom
 * interdit par le contrat n'est jamais activé même s'il est listé, les
 * extinctions passent d'abord, les activations ensuite et `skills` en
 * dernier. Tableau vide quand le profil est déjà au socle.
 *
 * `settable` est la liste que l'hôte accepte d'écrire (`GET /hermes-setup/toolsets`).
 * Un nom hors de cette liste n'est jamais écrit, ni éteint ni allumé : l'hôte
 * le refuserait (`TOOLSET_NOT_SETTABLE`). Mesuré sur le lab le 23-10-2026 :
 * `bfl`, posé par `pins.APIToolsets` dans chaque profil, n'est pas réglable
 * sous Hermes 0.22.2 et bloquait le socle de tous les bots.
 */
export function baselineToolsetWrites(
  inventory: ReadonlyArray<{ name: string; enabled: boolean }>,
  settable: ReadonlySet<string>,
  enabledSet: readonly string[] = BASELINE_ENABLED_TOOLSETS,
  options: { isolated?: boolean; additive?: boolean } = {},
): BaselineToolsetWrite[] {
  return baselineToolsetPlan(inventory, settable, enabledSet, options).writes;
}

export function baselineToolsetPlan(
  inventory: ReadonlyArray<{ name: string; enabled: boolean }>,
  settable: ReadonlySet<string>,
  enabledSet: readonly string[] = BASELINE_ENABLED_TOOLSETS,
  options: { isolated?: boolean; additive?: boolean } = {},
): BaselineToolsetPlan {
  // `memory` and `session_search` are allowed on an isolated profile only,
  // as the run preflight decides (`runtimeToolsetContractViolation`).
  const scope = options.isolated ? "profile" as const : "runtime" as const;
  const listed = new Map<string, boolean>();
  for (const toolset of inventory) if (!listed.has(toolset.name)) listed.set(toolset.name, toolset.enabled);
  const baseline = new Set(enabledSet);
  const writes: BaselineToolsetWrite[] = [];
  const unavailable: string[] = [];
  // An additive replay keeps what a bot already holds, except what the run
  // contract refuses on this profile (`memory` off an isolated profile).
  for (const [name, enabled] of listed) {
    if (!enabled || baseline.has(name) || !settable.has(name)) continue;
    if (!options.additive || runtimeToolsetNameIsContractForbidden(name, { scope })) writes.push({ name, enabled: false });
  }
  // `skills` passe en dernier de tous : le reste du socle est déjà posé quand il s'allume.
  const wanted = [...enabledSet.filter((name) => name !== "skills"), ...(baseline.has("skills") ? ["skills"] : [])];
  // L'inventaire hôte ne liste souvent que les toolsets actifs
  // (`profile_toolset_flags`, `inventory_probe.py`) : un nom du socle absent
  // est éteint, et s'allume comme un nom listé `false`.
  for (const name of wanted) {
    if (listed.get(name) === true || runtimeToolsetNameIsContractForbidden(name, { scope })) continue;
    if (settable.has(name)) writes.push({ name, enabled: true });
    else unavailable.push(name);
  }
  const required = unavailable.filter((name) => BASELINE_ENABLED_TOOLSETS.includes(name));
  return { writes, unavailable, required };
}
