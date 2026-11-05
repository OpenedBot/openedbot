/**
 * Ce que le navigateur retient du guichet : l'identifiant du fil et son jeton.
 *
 * Le jeton est un secret porteur : quiconque l'a lit le fil. Il ne vit donc
 * que dans `localStorage`, jamais dans l'URL, jamais dans un cookie envoyé
 * automatiquement. `localStorage` plutôt que `sessionStorage` : un visiteur
 * qui ferme son onglet et revient le lendemain doit retrouver sa réponse, et
 * c'est tout l'intérêt d'un guichet asynchrone.
 *
 * Effacer les données du site perd donc le fil. C'est assumé, et c'est la
 * raison pour laquelle l'adresse e-mail est demandée avant d'écrire : le staff
 * garde un moyen de répondre à quelqu'un que le navigateur a oublié.
 */

const STORAGE_KEY = "openedbot:support";

export type SupportSession = {
  conversationId: string;
  token: string;
};

/**
 * `localStorage` lève en navigation privée sur certains Safari, et rend `null`
 * dans un rendu serveur. Un guichet ne doit pas tomber pour cela : sans
 * mémoire, il ouvre simplement un fil neuf à chaque visite.
 */
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readSupportSession(): SupportSession | null {
  const raw = storage()?.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SupportSession>;
    if (typeof parsed.conversationId !== "string" || typeof parsed.token !== "string") return null;
    if (parsed.conversationId.length !== 36 || parsed.token.length < 16) return null;
    return { conversationId: parsed.conversationId, token: parsed.token };
  } catch {
    // Une valeur illisible est une valeur perdue : la retirer vaut mieux que
    // la relire à chaque ouverture du panneau.
    clearSupportSession();
    return null;
  }
}

export function writeSupportSession(session: SupportSession): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Quota plein ou écriture refusée : le fil de cette visite fonctionne
    // quand même, il ne survivra simplement pas au rechargement.
  }
}

export function clearSupportSession(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Rien à faire : la clé disparaîtra avec le stockage.
  }
}
