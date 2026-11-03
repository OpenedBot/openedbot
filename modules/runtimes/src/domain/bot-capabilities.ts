/**
 * Lecture du panneau « capacités » : la couche PURE, partagée par les clients.
 *
 * Le panneau répond à deux questions de PORTÉE différente et le modèle de vue
 * les garde séparées : « qu'est-ce que le runtime met à disposition » (commun
 * à tous les bots de l'organisation : mesuré le 25-08, `/v1/toolsets`
 * rend la même configuration pour la racine, `/p/neo` et `/p/scout`) et « qu'a
 * fait CE bot » (nos `run_events`). Les fondre en une liste unique ferait lire
 * « les skills de Pixel » là où il n'y a que « les skills du runtime ».
 */
import type { BotCapabilitiesDto, BotSkillDto, BotToolsetDto, BotToolUsageDto } from "@openedbot/contracts-api";
import {
  ALWAYS_FORBIDDEN_TOOLSETS,
  FORBIDDEN_TOOLSETS,
  PROFILE_RESTRICTED_TOOLSETS,
  runtimeToolsetIsForbidden,
  type RuntimeToolsetScope,
} from "./runtime-contract";

export type CapabilityToolsetView = BotToolsetDto & {
  /** Appels de CE bot sur les outils du toolset, dans la fenêtre de rétention. */
  calls: number;
  failures: number;
  /**
   * Le modèle peut l'appeler et l'appel n'aboutira pas. C'est la seule ligne
   * actionnable de l'inventaire : un `enabled` seul se lit « ça marche ».
   */
  willFail: boolean;
  /**
   * Ce toolset écrit ou lit un stockage qui vit sur la machine du runtime, hors
   * de notre base : voir `RUNTIME_SIDE_STORES`.
   */
  outOfReach: boolean;
  /** Ce toolset ne devrait PAS être actif : voir `FORBIDDEN_TOOLSETS`. */
  forbidden: boolean;
  /**
   * Actif, mais le runtime n'en annonce aucun outil : le modèle n'a rien à
   * appeler. Le toolset n'est pas pour autant coupé : un `enabled` seul se lit
   * « ça marche ».
   */
  noTools: boolean;
  /**
   * Actif, et l'hôte PROUVE (registre Hermes, `check_fn`) que ses outils ne
   * sont pas appelables : le modèle a un toolset et rien à appeler. Preuve,
   * pas heuristique : `available === false`.
   */
  unavailable: boolean;
  /** Pourquoi, quand l'hôte le donne (code fermé). */
  unavailableReason: BotToolsetDto["unavailableReason"];
  /**
   * Repli quand l'hôte ne dit RIEN (`available === null`, edge-setup ancien) :
   * actif, et ses outils ne sont annoncés au modèle que si un logiciel est
   * installé sur l'hôte (voir `HOST_SOFTWARE_TOOLSETS`). `/v1/toolsets` liste
   * les outils sans dire s'ils sont annoncés : openedbot nomme le prérequis sans le
   * prouver. Faux dès que l'hôte a mesuré, dans un sens ou dans l'autre.
   */
  needsHostSoftware: boolean;
};

/**
 * Les toolsets dont les outils n'existent côté modèle que si l'hôte porte un
 * logiciel que openedbot ne provisionne pas (frontière de release) : `browser`
 * exige `agent-browser` et Chromium (amont `tools/browser_tool_install.py`).
 * Sans eux Hermes n'annonce aucun outil browser, et `/v1/toolsets` les liste
 * quand même.
 */
export const HOST_SOFTWARE_TOOLSETS: ReadonlySet<string> = new Set(["browser"]);

/**
 * Le contrat runtime a UNE source : `runtime-contract.ts`. La liste des
 * toolsets interdits y vit avec les outils non suivis qu'ils fournissent :
 * les séparer laisserait un jour l'écran signaler ce que le worker ne
 * détecte plus, ou l'inverse.
 */
export { FORBIDDEN_TOOLSETS, ALWAYS_FORBIDDEN_TOOLSETS, PROFILE_RESTRICTED_TOOLSETS };

/**
 * Les toolsets dont l'effet SURVIT au run, côté runtime, hors d'openedbot.
 *
 * Mesuré le 26-08 : `memory` (« persistent memory across sessions »)
 * et `session_search` (« search past conversations ») sont tous deux actifs. Ce
 * qu'un bot y écrit ou y lit ne passe par aucune de nos tables : l'écran ne le
 * montre pas, l'opérateur ne l'efface pas, et la purge d'un compte ne l'atteint
 * pas : `/v1/capabilities` annonce `memory_write_api: false`, il n'existe même
 * pas d'endpoint pour aller le lire.
 *
 * Les nommer n'est pas une alerte de sécurité : c'est la frontière de ce que
 * cet écran peut promettre. Le reste des toolsets n'a d'effet que pendant le
 * run.
 */
export const RUNTIME_SIDE_STORES: ReadonlySet<string> = new Set(["memory", "session_search"]);

export type CapabilitySkillGroup = { category: string; skills: BotSkillDto[] };

export type CapabilityView = {
  toolsets: CapabilityToolsetView[] | null;
  skills: CapabilitySkillGroup[] | null;
  /**
   * Outils que ce bot a appelés et qu'aucun toolset ACTIF ne porte plus : une
   * capacité coupée depuis. Le taire ferait disparaître de l'écran des appels
   * qui ont réellement eu lieu, et laisserait inexpliqué un bot qui ne sait
   * soudain plus faire ce qu'il faisait la semaine dernière.
   */
  retiredUsage: BotToolUsageDto[];
  totals: {
    /** Outils réellement appelables : ceux des toolsets actifs. */
    tools: number;
    /** Parmi eux, ceux qui échoueront faute de configuration. */
    unconfigured: number;
    skills: number;
    /** Les toolsets actifs dont l'effet échappe à cet écran et à la purge. */
    outOfReach: string[];
    /** Les toolsets actifs que le protocole durable interdit. */
    forbidden: string[];
  };
};

/** Catégorie de repli d'une skill que le runtime n'a pas classée. */
export const UNCATEGORIZED_SKILLS = "";

export function capabilityView(dto: BotCapabilitiesDto): CapabilityView {
  const scope: RuntimeToolsetScope = dto.scope ?? "runtime";
  const usage = new Map(dto.usage.map((row) => [row.tool, row]));
  const claimed = new Set<string>();
  const toolsets = dto.toolsets?.map((toolset): CapabilityToolsetView => {
    let calls = 0;
    let failures = 0;
    for (const tool of toolset.tools) {
      // Un outil coupé garde son historique, mais ne « réclame » rien : sinon
      // il disparaîtrait de l'écran en même temps que son toolset.
      if (toolset.enabled) claimed.add(tool);
      const row = usage.get(tool);
      if (!row) continue;
      calls += row.calls;
      failures += row.failures;
    }
    return {
      ...toolset,
      calls,
      failures,
      willFail: toolset.enabled && !toolset.configured,
      // Sur un profil cloisonné, memory/session_search sont le magasin DU
      // bot, plus un stockage partagé hors d'openedbot.
      outOfReach: toolset.enabled && RUNTIME_SIDE_STORES.has(toolset.name) && scope !== "profile",
      forbidden: runtimeToolsetIsForbidden(toolset, { scope }),
      noTools: toolset.enabled && toolset.tools.length === 0,
      unavailable: toolset.enabled && toolset.available === false,
      unavailableReason: toolset.enabled && toolset.available === false ? toolset.unavailableReason : null,
      // `== null`: an older API sends no `available` at all.
      needsHostSoftware: toolset.enabled && toolset.available == null && HOST_SOFTWARE_TOOLSETS.has(toolset.name),
    };
  }).sort(compareToolsets) ?? null;

  const enabled = dto.toolsets?.filter((toolset) => toolset.enabled) ?? [];
  return {
    toolsets,
    skills: dto.skills === null ? null : groupSkills(dto.skills),
    retiredUsage: dto.usage.filter((row) => !claimed.has(row.tool)),
    totals: {
      tools: new Set(enabled.flatMap((toolset) => toolset.tools)).size,
      unconfigured: new Set(
        enabled.filter((toolset) => !toolset.configured).flatMap((toolset) => toolset.tools),
      ).size,
      skills: dto.skills?.length ?? 0,
      outOfReach: enabled
        .filter((toolset) => RUNTIME_SIDE_STORES.has(toolset.name) && scope !== "profile")
        .map((toolset) => toolset.name),
      forbidden: enabled.filter((toolset) => runtimeToolsetIsForbidden(toolset, { scope })).map((toolset) => toolset.name),
    },
  };
}

/**
 * L'ordre EST le message : ce qui ne devrait pas être là, puis ce qui va
 * casser, puis ce qui sert le plus, puis ce qui dort. Un tri alphabétique
 * noierait les seules lignes à lire.
 */
function compareToolsets(left: CapabilityToolsetView, right: CapabilityToolsetView): number {
  if (left.forbidden !== right.forbidden) return left.forbidden ? -1 : 1;
  if (left.willFail !== right.willFail) return left.willFail ? -1 : 1;
  if (left.unavailable !== right.unavailable) return left.unavailable ? -1 : 1;
  if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
  if (left.calls !== right.calls) return right.calls - left.calls;
  return left.name.localeCompare(right.name);
}

function groupSkills(skills: BotSkillDto[]): CapabilitySkillGroup[] {
  const groups = new Map<string, BotSkillDto[]>();
  for (const skill of skills) {
    const category = skill.category ?? UNCATEGORIZED_SKILLS;
    const bucket = groups.get(category);
    if (bucket) bucket.push(skill);
    else groups.set(category, [skill]);
  }
  return [...groups.entries()]
    .map(([category, entries]) => ({
      category,
      skills: [...entries].sort((left, right) => left.name.localeCompare(right.name)),
    }))
    // Les plus fournies d'abord ; le repli sans catégorie ferme la marche.
    .sort((left, right) => {
      if ((left.category === UNCATEGORIZED_SKILLS) !== (right.category === UNCATEGORIZED_SKILLS)) {
        return left.category === UNCATEGORIZED_SKILLS ? 1 : -1;
      }
      if (left.skills.length !== right.skills.length) return right.skills.length - left.skills.length;
      return left.category.localeCompare(right.category);
    });
}
