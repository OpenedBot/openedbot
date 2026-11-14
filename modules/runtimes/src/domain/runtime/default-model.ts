/**
 * Le modèle proposé d'office quand personne n'en a choisi : la gamme
 * « courante » d'une famille, jamais son haut de gamme. Claude : Sonnet (pas
 * Fable ni Opus). GPT : Luna (pas Sol, Astra ni Terra). Gemini : Flash (pas
 * Pro). Un choix explicite (runtime, bot, réglages) passe toujours devant :
 * cette règle ne remplace que « le premier de la liste » ou le modèle de l'hôte.
 */
const DEFAULT_TIERS: readonly RegExp[] = [
  /(^|[/-])claude-sonnet-/,
  /(^|[/-])gpt-[\d.]+-luna(?=$|-)/,
  /(^|[/-])gemini-[\d.]+-flash(?=$|-)(?!-lite)/,
];

/** Une variante à fenêtre longue (`gpt-6-luna-900k`) coûte plus : jamais d'office. */
const LONG_CONTEXT = /-\d+[km]$/;

/**
 * La version et la date portées par un id de modèle, pour le classer par
 * sortie : Hermes ne publie aucune date, et son ordre mêle les générations
 * (`claude-haiku-4-5-20251001` après `claude-opus-5`).
 *
 * Le premier nombre de l'id est la version majeure (`gpt-6.1-sol` : 6,
 * `claude-opus-4-5` : 4). La mineure suit après un point ou dans le segment
 * suivant de un ou deux chiffres, et se lit en décimale : `grok-4.20` vaut
 * 4,2, avant `grok-4.3`. Un segment de quatre à huit chiffres qui suit est une
 * date (`-20251101`, `-0309`). Un id sans nombre n'a pas de version.
 */
export function releaseKey(id: string): { major: number; minor: number; date: number } | null {
  const parts = id.split("-");
  const index = parts.findIndex((part) => /^\d+(\.\d+)?$/.test(part));
  if (index < 0) return null;
  const [majorText, dottedMinor] = parts[index]!.split(".");
  let next = index + 1;
  let minorText = dottedMinor ?? "";
  if (!dottedMinor && /^\d{1,2}$/.test(parts[next] ?? "")) minorText = parts[next++]!;
  const dateText = /^\d{4,8}$/.test(parts[next] ?? "") ? parts[next]! : "";
  return {
    major: Number(majorText),
    minor: minorText ? Number(`0.${minorText}`) : 0,
    date: dateText ? Number(dateText) : 0,
  };
}

/** Plus récent d'abord ; à version égale l'ordre reçu est gardé, sans version en dernier. */
export function compareRelease(left: string, right: string): number {
  const a = releaseKey(left);
  const b = releaseKey(right);
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  return b.major - a.major || b.minor - a.minor || b.date - a.date;
}

/**
 * Le plus récent modèle de la gamme courante parmi `models`, ou `null` quand
 * le fournisseur n'en a pas (Grok, OpenRouter sans Claude…) : l'appelant garde
 * alors son repli d'avant.
 */
export function defaultTierModel<T extends { id: string }>(models: readonly T[]): T | null {
  for (const tier of DEFAULT_TIERS) {
    const candidates = models.filter((model) => tier.test(model.id.toLowerCase()) && !LONG_CONTEXT.test(model.id));
    if (candidates.length) return [...candidates].sort((left, right) => compareRelease(left.id, right.id))[0]!;
  }
  return null;
}
