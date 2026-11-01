/**
 * Mode YOLO : la graine Ed25519 qui signe les baux, et celles des clés
 * retirées dont les baux encore vivants (24 h au plus) doivent rester
 * vérifiables par l'hôte. Optionnelles : sans clé courante l'API démarre,
 * mais refuse tout octroi (503 `YOLO_SIGNING_UNAVAILABLE`) : jamais de bail
 * non signé. Une valeur posée mais mal formée arrête le démarrage, sans être
 * citée dans l'erreur.
 *
 * Les clés retirées sont des GRAINES (secrètes), pas des clés publiques :
 * l'API n'en publie que la partie publique, dérivée ici, ce qui écarte le
 * risque de publier par erreur une graine collée à la place d'une clé
 * publique (les deux ont la même forme).
 */
export type YoloLeaseSigningConfig = {
  /** `null` : aucun octroi possible. */
  seed: Uint8Array | null;
  previousSeeds: Uint8Array[];
};

function decodeSeed(value: string, name: string): Uint8Array {
  const bytes = Uint8Array.from(Buffer.from(value, "base64"));
  if (bytes.byteLength !== 32 || Buffer.from(bytes).toString("base64") !== value) {
    throw new Error(`${name} must be an Ed25519 seed: 32 bytes in base64.`);
  }
  return bytes;
}

export function readYoloLeaseSigningConfig(env: Record<string, string | undefined>): YoloLeaseSigningConfig {
  const current = env.OPENEDBOT_YOLO_LEASE_SIGNING_KEY?.trim();
  const previous = (env.OPENEDBOT_YOLO_LEASE_PREVIOUS_KEYS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  return {
    seed: current ? decodeSeed(current, "OPENEDBOT_YOLO_LEASE_SIGNING_KEY") : null,
    previousSeeds: previous.map((value, index) => decodeSeed(value, `OPENEDBOT_YOLO_LEASE_PREVIOUS_KEYS[${index}]`)),
  };
}
