/**
 * Sélection de modèle déjà résolue pour le même bot, le même lien et le même
 * modèle stocké. Le tour suivant n'attend plus le catalogue (DEV-214), qui
 * coûte un aller-retour vers l'hôte (p50 219 ms à froid, mesuré sur 79 runs).
 *
 * 10 min au lieu des 45 s du cache de préflight Hermes : la clé porte déjà
 * l'instant du lien (une reconnexion la change), l'instant du dernier
 * `inventory.changed` de l'hôte (une réécriture de `config.yaml`, `.env`,
 * `mcp-tokens` ou d'un profil la change, sondée toutes les 5 s) et le
 * fournisseur, le modèle, l'effort, le mode rapide et le profil stockés.
 * Un choix devenu faux sans signal (hôte qui ne sonde pas, incident chez le
 * fournisseur) échoue chez Hermes et passe par la reprise de fournisseur
 * existante (`runner/provider-recovery.ts`), qui mémorise le repli résolu.
 * L'âge max borne ce qui reste : au-delà on relit le catalogue.
 */
export const WARM_MODEL_SELECTION_TTL_MS = 600_000;
/**
 * Plafond du cache, partagé par tous les tenants d'un worker. Une clé change à
 * chaque reconnexion, changement de modèle ou profil supprimé : l'ancienne
 * n'est plus relue, la mémoire ne doit donc pas dépendre des relectures.
 */
export const WARM_MODEL_SELECTION_MAX_ENTRIES = 1_000;

export type WarmModelSelection = {
  provider: string | null;
  model: string;
  reasoningEffort: string | null;
  fastMode?: boolean;
};

export type WarmModelSelectionKeyInput = {
  organizationId: string;
  runtimeId: string;
  profile: string | null;
  provider: string | null;
  model: string | null;
  reasoningEffort: string | null;
  /** In the key: switching the fast mode must not reuse the other one's resolution. */
  fastMode?: boolean;
  linkConnectedAt: string | null;
  /** `runtimes.inventory_changed_at` : un `inventory.changed` de l'hôte change la clé. */
  inventoryChangedAt: string | null;
};

type Stamp = { atMs: number; selection: WarmModelSelection };

const stamps = new Map<string, Stamp>();

/** `null` quand aucun modèle n'est stocké : il n'y a rien à réutiliser. */
export function warmModelSelectionKey(input: WarmModelSelectionKeyInput): string | null {
  const model = input.model?.trim() ?? "";
  if (!input.organizationId || !input.runtimeId || !model) return null;
  return [
    input.organizationId,
    input.runtimeId,
    input.profile ?? "",
    input.provider ?? "",
    model,
    input.reasoningEffort ?? "",
    input.fastMode === true ? "fast" : "",
    input.linkConnectedAt ?? "",
    input.inventoryChangedAt ?? "",
  ].join("\u0001");
}

export function readWarmModelSelection(
  key: string | null,
  nowMs: number,
  ttlMs = WARM_MODEL_SELECTION_TTL_MS,
): WarmModelSelection | null {
  if (!key) return null;
  const stamp = stamps.get(key);
  if (!stamp) return null;
  if (nowMs - stamp.atMs >= ttlMs) {
    stamps.delete(key);
    return null;
  }
  return stamp.selection;
}

export function rememberWarmModelSelection(
  key: string | null,
  selection: { provider: string | null; model: string | null; reasoningEffort: string | null; fastMode?: boolean },
  nowMs: number,
): void {
  const model = selection.model?.trim() ?? "";
  if (!key || !model) return;
  // Chaque écriture purge les entrées expirées, puis, si le plafond tient
  // encore, la plus ancienne écrite (une clé réécrite repasse en fin d'ordre).
  for (const [stale, stamp] of stamps) {
    if (nowMs - stamp.atMs >= WARM_MODEL_SELECTION_TTL_MS) stamps.delete(stale);
  }
  stamps.delete(key);
  while (stamps.size >= WARM_MODEL_SELECTION_MAX_ENTRIES) {
    const oldest = stamps.keys().next().value;
    if (oldest === undefined) break;
    stamps.delete(oldest);
  }
  stamps.set(key, {
    atMs: nowMs,
    selection: {
      provider: selection.provider,
      model,
      reasoningEffort: selection.reasoningEffort,
      ...(selection.fastMode === true ? { fastMode: true } : {}),
    },
  });
}

/**
 * Chemin chaud : la sélection déjà en main part telle quelle, sans relancer
 * le passage `preflight.model_selection`. Sinon on appelle `select` (le span
 * et le catalogue vivent dans cet appel).
 */
export async function takeWarmOrSelectModel<T extends { model: string | null }>(
  warm: T | null,
  select: () => Promise<T | null>,
): Promise<T | null> {
  if (warm?.model) return warm;
  return select();
}

/** Taille du cache, pour les tests du plafond. */
export function warmModelSelectionSize(): number {
  return stamps.size;
}

export function resetWarmModelSelection(): void {
  stamps.clear();
}
