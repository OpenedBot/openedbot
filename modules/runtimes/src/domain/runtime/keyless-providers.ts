/**
 * Les fournisseurs qu'Hermes sert **sans aucun credential**.
 *
 * Hermes les déclare pourtant `auth_type="api_key"` : c'est le seul type
 * dont dispose son registre pour « pas OAuth », d'où le badge « Clé API »
 * et le formulaire de clé qu'openedbot leur offrait à tort. Vérifié dans l'amont
 * (`hermes_cli/auth.py`, `ProviderConfig("opencode-free")`) le 05-09-2026 :
 * `api_key_env_vars=()`, et le relais répond 401 à tout bearer qu'il ne
 * reconnaît pas, placeholder compris (`agent_runtime_helpers.py`, politique
 * `opencode_zen_free_headers`). Il n'y a donc ni clé à saisir, ni compte, ni
 * relevé d'usage à lire : le quota du tier gratuit s'applique par adresse IP,
 * côté opencode.ai.
 *
 * La liste est **exacte**, jamais un motif : `opencode-zen` et `opencode-go`
 * sont des accès payants à clé, sur le même hôte.
 */
const KEYLESS_PROVIDERS: ReadonlySet<string> = new Set(["opencode-free"]);

export function isKeylessProvider(slug: string): boolean {
  return KEYLESS_PROVIDERS.has(slug);
}
