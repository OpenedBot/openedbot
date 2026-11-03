import { api, queryKeys } from "../api";
import { queryClient } from "../query-client";

/**
 * Connecteurs lit deux routes dont la lecture « froide » démarre un
 * interpréteur sur l'hôte du runtime (mesuré le 02-11-2026 : 2,6 s pour
 * l'inventaire, 1,9 s pour MCP, contre moins de 10 ms une fois l'instantané
 * serveur en place). L'écran ne les lançait qu'à son montage : un squelette
 * pendant toute la lecture.
 *
 * Les lancer dès l'entrée dans les réglages (`SettingsFrame`) laisse le temps du trajet jusqu'à
 * la rubrique. Un échec (non-opérateur, hôte hors ligne) est avalé ici : c'est
 * l'écran qui, en les relisant, affichera l'erreur.
 */
export function prefetchConnectors(): void {
  void queryClient.prefetchQuery({ queryKey: queryKeys.runtimeIntegrations, queryFn: () => api.runtimeIntegrations() });
  void queryClient.prefetchQuery({ queryKey: queryKeys.runtimeMcp, queryFn: api.runtimeMcp });
}
