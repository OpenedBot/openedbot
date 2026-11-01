/**
 * Le parcours d'accueil de la PWA, modèle Multica.
 *
 * Un écran d'accueil (« welcome », intro produit, jamais persisté et sans
 * indicateur de progression), puis deux étapes dans le rail, dans cet ordre
 * et pas un autre : « Espace de travail » (l'organisation, personnelle ou
 * agence, son nom, et le nom d'utilisateur) et « Configuration » (la machine,
 * le fournisseur d'IA et le modèle du runtime). Aucun bot ne se crée ici :
 * la sortie ouvre l'application, qui propose le premier bot.
 */
export type OnboardingStep = "welcome" | "workspace" | "runtime";

/** Les étapes du rail, sans `welcome`, qui n'est pas une progression. */
export type RailStep = Exclude<OnboardingStep, "welcome">;

/**
 * L'ordre canonique des étapes persistées. Seule source de vérité pour « quoi
 * après quoi » : l'indicateur de progression et la navigation en dérivent.
 */
export const ONBOARDING_STEP_ORDER: readonly RailStep[] = [
  "workspace",
  "runtime",
] as const;

export function isRailStep(step: OnboardingStep): step is RailStep {
  return (ONBOARDING_STEP_ORDER as readonly string[]).includes(step);
}

/** L'étape qui suit `from` dans le rail, `null` après la dernière (ou hors rail). */
export function nextStep(from: OnboardingStep): RailStep | null {
  if (from === "welcome") return ONBOARDING_STEP_ORDER[0]!;
  const index = ONBOARDING_STEP_ORDER.indexOf(from);
  if (index < 0 || index >= ONBOARDING_STEP_ORDER.length - 1) return null;
  return ONBOARDING_STEP_ORDER[index + 1]!;
}

/** L'étape d'avant : la première du rail revient à l'accueil ; l'accueil n'a pas d'avant. */
export function prevStep(from: OnboardingStep): OnboardingStep | null {
  if (from === "welcome") return null;
  const index = ONBOARDING_STEP_ORDER.indexOf(from);
  return index <= 0 ? "welcome" : ONBOARDING_STEP_ORDER[index - 1]!;
}

/** Le rang (0-based) d'une étape dans le rail ; `welcome` vaut 0. */
export function railIndex(step: OnboardingStep): number {
  return Math.max(0, ONBOARDING_STEP_ORDER.indexOf(step as RailStep));
}

// ── Espace de travail ────────────────────────────────────────────────────────

/**
 * Les identités « au hasard » du bouton dés, célestes chez Multica, célestes
 * ici aussi : des noms courts, lisibles dans les deux langues.
 */
export const RANDOM_WORKSPACE_NAMES: readonly string[] = [
  "Andromède",
  "Cassiopée",
  "Orion",
  "Véga",
  "Altaïr",
  "Sirius",
  "Lyra",
  "Nova",
  "Pulsar",
  "Quasar",
  "Zénith",
  "Aurore",
] as const;

export function randomWorkspaceName(random = Math.random): string {
  return RANDOM_WORKSPACE_NAMES[Math.floor(random() * RANDOM_WORKSPACE_NAMES.length)] ?? "Nova";
}
