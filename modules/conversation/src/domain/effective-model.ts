/**
 * Le modèle d'un fil : le réglage du bot, sinon celui du runtime. Un bot qui
 * hérite du modèle du runtime porte `''` (pas NULL) : un simple `??` garderait
 * cette chaîne vide et n'irait jamais chercher le modèle du runtime.
 */
export function effectiveThreadModel(
  botModel: string | null | undefined,
  runtimeModel: string | null | undefined,
): string {
  if (typeof botModel === "string" && botModel.trim()) return botModel;
  if (typeof runtimeModel === "string" && runtimeModel.trim()) return runtimeModel;
  return "";
}
