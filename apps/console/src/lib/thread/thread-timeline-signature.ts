import type { Entry } from "./thread-timeline-model";

/**
 * Le `runId` porté par une entrée, quel que soit son genre (`event` le
 * garde sous `event.runId`, `gate` sous `approval.runId`). Sert à la fois au
 * cache de nœuds ci-dessous et au calcul du tour « réglé ».
 */
export function entryRunId(entry: Entry): string | null {
  switch (entry.kind) {
    case "event":
      return entry.event.runId;
    case "gate":
      return entry.approval.runId ?? null;
    default:
      return entry.runId;
  }
}

/**
 * Signature de VALEUR d'une entrée, tous ses champs propres, `JSON`
 * générique plutôt qu'un tri à la main : plus sûr contre un champ oublié
 * qu'une liste manuelle, et bien moins coûteux que reconstruire le nœud
 * React (markdown, enfants mémoïsés) qu'elle évite (voir `turnNodeCache`
 * dans `ThreadTimelineView`).
 *
 * Mémoïsée par entrée : le modèle incrémental rend les MÊMES objets pour
 * les blocs inchangés, et une entrée n'est plus modifiée une fois rendue.
 */
const entrySignatures = new WeakMap<Entry, string>();
export function entrySignature(entry: Entry): string {
  let signature = entrySignatures.get(entry);
  if (signature === undefined) {
    signature = JSON.stringify(entry);
    entrySignatures.set(entry, signature);
  }
  return signature;
}

/** Ce qu'un auteur change au rendu d'un tour : identité, nom, slug, visage. */
export function authorRenderKey(author: { id: string; name?: string | null; slug?: string | null; face?: unknown } | null | undefined): string {
  return author ? `${author.id}:${author.name ?? ""}:${author.slug ?? ""}:${JSON.stringify(author.face ?? null)}` : "";
}
