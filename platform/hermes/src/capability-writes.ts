/**
 * Les écritures relayées qui changent ce qu'un bot peut faire : ses toolsets,
 * ses skills, ses serveurs MCP et les identifiants qui rendent un toolset
 * disponible. Le broker du lien les repère ici et marque le runtime (0163) ;
 * au message suivant, un fil dont la session Hermes est plus ancienne passe à
 * une session neuve, seule façon pour Hermes de reconstruire le prompt et les
 * outils qu'il a figés au premier tour.
 *
 * `profile` : le profil Hermes visé (`/hermes-setup/profiles/<slug>/…`),
 * `null` pour la racine de l'hôte. Le connecteur ignore le préfixe
 * `/p/<slug>` d'une route de l'hôte (`hostTarget`) : seul le chemin compte.
 * Deux écritures de racine valent pour tous les bots : le rappel OAuth d'un
 * serveur MCP (le profil n'est nommé que dans la demande d'autorisation, pas
 * dans le rappel) et le redémarrage du gateway, qui relit les serveurs MCP de
 * tous. Une rotation de trop ne coûte qu'un défaut de cache.
 *
 * Lectures, runs, modèle, mémoire, politique d'accord et création ou
 * suppression d'un profil ne changent rien à ce que voit une session ouverte
 * de ce bot : ils ne sont pas ici.
 */
export type HermesCapabilityWrite = { profile: string | null };

const PROFILE = "[a-z0-9][a-z0-9_-]{0,62}";
const NAME = "[A-Za-z0-9][A-Za-z0-9_-]{0,63}";

const ROOT_WRITES: ReadonlyArray<readonly [string, RegExp]> = Object.freeze([
  ["POST", new RegExp(`^/hermes-setup/toolsets/${NAME}$`)],
  ["POST", /^\/hermes-setup\/mcp\/servers$/],
  ["DELETE", new RegExp(`^/hermes-setup/mcp/servers/${NAME}$`)],
  ["POST", new RegExp(`^/hermes-setup/mcp/catalog/${NAME}$`)],
  ["POST", new RegExp(`^/hermes-setup/mcp/servers/${NAME}/oauth/callback$`)],
  ["POST", new RegExp(`^/hermes-setup/providers/${NAME}/credentials$`)],
  ["POST", /^\/hermes-setup\/gateway\/restart$/],
] as const);

const PROFILE_WRITES: ReadonlyArray<readonly [string, RegExp]> = Object.freeze([
  ["POST", new RegExp(`^/hermes-setup/profiles/(${PROFILE})/toolsets/${NAME}$`)],
  ["POST", new RegExp(`^/hermes-setup/profiles/(${PROFILE})/toolsets$`)],
  ["POST", new RegExp(`^/hermes-setup/profiles/(${PROFILE})/mcp/servers/${NAME}$`)],
  ["DELETE", new RegExp(`^/hermes-setup/profiles/(${PROFILE})/mcp/servers/${NAME}$`)],
  ["POST", new RegExp(`^/hermes-setup/profiles/(${PROFILE})/skills/${NAME}$`)],
  ["DELETE", new RegExp(`^/hermes-setup/profiles/(${PROFILE})/skills/${NAME}$`)],
  ["POST", new RegExp(`^/hermes-setup/profiles/(${PROFILE})/bundled-skills$`)],
  ["POST", new RegExp(`^/hermes-setup/profiles/(${PROFILE})/skills/hub/install$`)],
  ["POST", new RegExp(`^/hermes-setup/profiles/(${PROFILE})/providers/${NAME}/credentials$`)],
  ["DELETE", new RegExp(`^/hermes-setup/profiles/(${PROFILE})/providers/${NAME}/credentials$`)],
] as const);

const PROFILE_PREFIX = new RegExp(`^/p/${PROFILE}(?=/)`);

export function hermesCapabilityWrite(method: string, path: string): HermesCapabilityWrite | null {
  const query = path.indexOf("?");
  const candidate = (query >= 0 ? path.slice(0, query) : path).replace(PROFILE_PREFIX, "");
  const verb = method.toUpperCase();
  for (const [expected, pattern] of PROFILE_WRITES) {
    if (expected !== verb) continue;
    const match = pattern.exec(candidate);
    if (match) return { profile: match[1]! };
  }
  for (const [expected, pattern] of ROOT_WRITES) {
    if (expected === verb && pattern.test(candidate)) return { profile: null };
  }
  return null;
}
