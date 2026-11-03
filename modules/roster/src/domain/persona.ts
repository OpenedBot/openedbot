/**
 * La persona d'un bot : la couche PURE, partagée web et clients natifs.
 *
 * `bots.instructions` est le texte injecté en tête de CHAQUE run, avant le
 * protocole bot-mode. C'est le seul champ que l'opérateur écrit et que le
 * modèle lit mot pour mot : ni gabarit, ni rendu intermédiaire. D'où le choix
 * d'un éditeur de texte brut plutôt que d'un éditeur riche : le markdown que
 * le modèle lit nativement reste le texte tapé, sans couche de sérialisation
 * entre les deux.
 *
 * `composePersona` est le seul rendu déterministe : il produit le texte
 * initial à la création, calqué sur `composeSoul` de Hermes Bot Mode. Une
 * fois enregistré, le résultat est de la persona comme une autre, jamais
 * recomposé au run.
 */

/**
 * Plafond accepté par l'API (`domain/bot-input.ts`). Le dépassement est refusé,
 * jamais rogné : une persona tronquée en silence retire au bot une partie de
 * son cadrage sans que personne ne l'apprenne, et le premier symptôme est un
 * bot qui « change de caractère » sans raison visible.
 */
export const PERSONA_MAX_CHARS = 100_000;

/**
 * Caractères par jeton, mesuré le 25-08 : les deltas d'entrée
 * (0 car. → 11 661 jetons ; 135 → 11 695 ; 270 → 11 729) donnent ~1 jeton pour
 * 3 à 4 caractères. On prend 3,5 : une ESTIMATION, affichée comme telle.
 */
const CHARS_PER_TOKEN = 3.5;

export const PERSONA_ROLE_MAX_CHARS = 200;
export const PERSONA_MISSION_MAX_CHARS = 1_000;

export type PersonaMetrics = {
  chars: number;
  /** Reste avant le plafond. Négatif = ce qui devra partir. */
  remaining: number;
  overLimit: boolean;
  /**
   * Jetons ajoutés à CHAQUE run par cette persona. À lire à côté du plancher
   * mesuré du runtime (11 700–14 750 jetons avant toute conversation, prompt
   * système + 39 outils + 77 skills) : c'est ce plancher qui rend une persona
   * longue coûteuse, et c'est ce que ce compteur rend visible avant l'envoi.
   */
  estimatedTokens: number;
};

export function personaMetrics(text: string): PersonaMetrics {
  // Le serveur `trim()` avant de mesurer : compter les espaces de bord ferait
  // annoncer un dépassement que l'enregistrement ne produira pas.
  const chars = text.trim().length;
  return {
    chars,
    remaining: PERSONA_MAX_CHARS - chars,
    overLimit: chars > PERSONA_MAX_CHARS,
    estimatedTokens: Math.ceil(chars / CHARS_PER_TOKEN),
  };
}

export type ComposePersonaInput = {
  name: string;
  role?: string | null;
  mission?: string | null;
};

/**
 * Compose la persona initiale d'un bot. Déterministe, sans appel modèle.
 *
 * Calque de Hermes `composeSoul` : un titre, `**Role:**`, `**Mission:**`,
 * puis le paragraphe de cadrage. Un bot ne part jamais avec un prompt vide,
 * le nom suffit à produire un texte.
 */
/**
 * Persona à la création. Un texte explicite (clone, import, éditeur) est
 * conservé. Un champ absent ou vide déclenche `composePersona` : un bot
 * nouveau ne part jamais avec un prompt vide.
 */
export function resolveCreateInstructions(input: {
  instructions?: string | null;
  name: string;
  role?: string | null;
  mission?: string | null;
}): string {
  if (typeof input.instructions === "string") {
    const trimmed = input.instructions.trim();
    if (trimmed) return trimmed;
  }
  return composePersona({
    name: input.name,
    role: input.role,
    mission: input.mission,
  });
}

/**
 * Texte affiché (et envoyé) à la création. Tant que l'humain n'a pas
 * touché le champ, c'est `composePersona` : le même octet que
 * `resolveCreateInstructions` sans `instructions`. Dès qu'il a édité,
 * son texte est conservé tel quel, y compris s'il est vide : on ne
 * recompose jamais par-dessus une saisie.
 */
export function displayedCreatePersona(input: {
  name: string;
  role?: string | null;
  mission?: string | null;
  editedText?: string | null;
  edited: boolean;
}): string {
  if (input.edited) return input.editedText ?? "";
  return composePersona({
    name: input.name,
    role: input.role,
    mission: input.mission,
  });
}

export function composePersona(input: ComposePersonaInput): string {
  const name = input.name.trim() || "Bot";
  const role = input.role?.trim().slice(0, PERSONA_ROLE_MAX_CHARS) || name;
  const mission =
    input.mission?.trim().slice(0, PERSONA_MISSION_MAX_CHARS)
    || `Act as ${name} on every turn. Keep your own memory, skills, and conversation history.`;
  return [
    `# ${name}`,
    "",
    `**Role:** ${role}`,
    `**Mission:** ${mission}`,
    "",
    `You are a persistent named agent (${name}). You keep your own memory, skills, and conversation history. Speak as this identity on every turn.`,
  ].join("\n");
}
