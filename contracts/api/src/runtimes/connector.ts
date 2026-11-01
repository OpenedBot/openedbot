/**
 * Comment openedbot atteint le runtime.
 *
 * `connector` est le seul état produit. `direct` reste dans cette union le
 * temps de lire et révoquer les lignes créées par les migrations historiques ;
 * aucune API ne peut plus en créer et le worker ne les exécute plus.
 */
export type RuntimeReachability = "direct" | "connector";

export type RuntimeConnectorDto = {
  agent: string;
  version: string | null;
  latestVersion: string | null;
  minimumVersion: string | null;
  outdated: boolean;
  updateAvailable: boolean;
  seenAt: string | null;
  upgradeCommand: "sudo edge-setup upgrade --yes";
};

/**
 * La dernière release publique d'edge-setup, telle que l'API l'a lue (l'ancre
 * `openedbot.app/.well-known/edge-setup.json`, ou la release d'un miroir) :
 * ses notes sont la section du CHANGELOG, en markdown borné, sans HTML, ou
 * vides quand l'ancre n'en porte pas.
 */
export type ConnectorReleaseDto = {
  version: string;
  publishedAt: string | null;
  notes: string;
  url: string;
};

/**
 * `GET /api/runtimes/connector-release`. `seen` : l'utilisateur a déjà fermé
 * l'annonce de cette version dans cette organisation. openedbot ne met jamais
 * l'hôte à jour lui-même : il ne remet que les deux commandes.
 */
export type ConnectorReleaseResponse = {
  release: ConnectorReleaseDto | null;
  seen: boolean;
  upgradeCommand: "sudo edge-setup upgrade --yes";
  autoUpgradeCommand: "sudo edge-setup auto-upgrade enable --yes";
};
