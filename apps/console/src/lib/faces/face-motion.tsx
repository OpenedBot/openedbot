import { createContext, useContext, type ReactNode } from "react";

/**
 * Est-ce qu'un visage bouge, ici ?
 *
 * La réponse par défaut est oui, c'est le contrat de grokbot, dont l'avatar
 * s'anime partout et n'expose que des opt-out (`paused`, `isStatic`). Un bot
 * figé dans une liste ressemble à une icône ; un bot qui respire ressemble à
 * quelqu'un.
 *
 * L'exception se pose par sous-arbre, pas par appelant : les réglages
 * (`/settings` et toutes ses rubriques) sont un écran de formulaire, où trente
 * frimousses qui respirent pendant qu'on remplit un champ sont du bruit. C'est
 * le cadre de la route qui le déclare, une fois, et non chaque `BotFace` qui
 * teste l'URL.
 */
const FaceMotionContext = createContext(true);

export function FaceMotionProvider({ anime, children }: { anime: boolean; children: ReactNode }) {
  return <FaceMotionContext.Provider value={anime}>{children}</FaceMotionContext.Provider>;
}

/** `true` quand les visages de ce sous-arbre ont le droit de vivre. */
export function useFaceMotion(): boolean {
  return useContext(FaceMotionContext);
}
