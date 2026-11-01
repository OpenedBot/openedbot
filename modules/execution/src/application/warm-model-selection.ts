/**
 * Sélection de modèle déjà résolue pour le même bot, le même lien et le même
 * modèle stocké. Le tour suivant n'attend plus le catalogue (DEV-214).
 * L'âge max reprend le TTL du cache de préflight Hermes (45 s) : au-delà on
 * relit, pour qu'un incident ou une réécriture de profil ne restent pas collés.
 */
export const WARM_MODEL_SELECTION_TTL_MS = 45_000;

export type WarmModelSelection = {
  provider: string | null;
  model: string;
  reasoningEffort: string | null;
};

export type WarmModelSelectionKeyInput = {
  organizationId: string;
  runtimeId: string;
  profile: string | null;
  provider: string | null;
  model: string | null;
  reasoningEffort: string | null;
  linkConnectedAt: string | null;
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
    input.linkConnectedAt ?? "",
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
  selection: { provider: string | null; model: string | null; reasoningEffort: string | null },
  nowMs: number,
): void {
  const model = selection.model?.trim() ?? "";
  if (!key || !model) return;
  stamps.set(key, {
    atMs: nowMs,
    selection: {
      provider: selection.provider,
      model,
      reasoningEffort: selection.reasoningEffort,
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

export function resetWarmModelSelection(): void {
  stamps.clear();
}
