/** Les deux cibles de la mémoire du runtime : `MEMORY.md` (projet) et `USER.md` (opérateur). */
export type RuntimeMemoryTarget = "memory" | "user";

/**
 * La mémoire d'un bot à profil géré, telle que le RUNTIME la tient : les
 * entrées de `MEMORY.md` et `USER.md` du profil, lues et écrites par le
 * magasin Hermes lui-même (mêmes plafonds, même format que l'outil `memory`
 * du bot). C'est la seule mémoire d'un tel bot : openedbot n'injecte plus rien.
 *
 * `available: false` dit pourquoi l'écran doit retomber sur la mémoire openedbot
 * (bot sans profil) ou afficher un état : hôte sans la feature, runtime absent.
 */
export type BotRuntimeMemoryDto =
  | { available: false; reason: "no_profile" | "runtime_missing" | "feature_missing" }
  | {
      available: true;
      profile: string;
      /** Le toolset `memory` du profil, donc ses deux drapeaux, sont actifs. */
      enabled: boolean;
      limits: Record<RuntimeMemoryTarget, number>;
      entries: Record<RuntimeMemoryTarget, string[]>;
      usedChars: Record<RuntimeMemoryTarget, number>;
      /** Message du magasin après une écriture, sinon `null`. */
      message: string | null;
    };

export type BotRuntimeMemoryWriteInput = {
  target: RuntimeMemoryTarget;
  action: "add" | "replace" | "remove";
  content?: string;
  /** Sous-chaîne unique de l'entrée visée (`replace`, `remove`). */
  oldText?: string;
};
