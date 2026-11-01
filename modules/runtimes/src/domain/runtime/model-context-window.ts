/**
 * Les fenêtres de contexte par modèle, reprises de l'amont.
 *
 * Elles servent au runtime qui ne publie PAS sa fenêtre : dans ce cas openedbot ne
 * parle qu'au gateway Hermes, et le gateway ne la porte nulle part.
 * `/v1/models` ne rend qu'un identifiant, `/api/model/options` l'inventaire du
 * sélecteur, `/v1/capabilities` des drapeaux. Vérifié le 09-09-2026 sur
 * `gateway/platforms/api_server.py`.
 *
 * La table et la règle de recherche sont celles de
 * `agent/model_metadata.py` (`DEFAULT_CONTEXT_LENGTHS`, `_longest_key_match`,
 * `DEFAULT_FALLBACK_CONTEXT`), relevées le 09-09-2026. Ce n'est donc pas une
 * estimation d'openedbot : c'est ce que l'agent applique lui-même quand ni le
 * catalogue du fournisseur ni la sonde ne répondent. Un runtime qui répond
 * reste prioritaire, parce que lui seul connaît l'override de configuration
 * de son hôte.
 *
 * Deux pièges de l'amont, reproduits tels quels :
 *
 *   - la recherche est une SOUS-CHAÎNE, pas une égalité. `gpt-5.6-luna` est
 *     trouvé dans `openai/gpt-5.6-luna-preview`.
 *   - c'est la clé la PLUS LONGUE qui gagne, pour que `gpt-5.4-mini` batte le
 *     fourre-tout `gpt-5`. Une clé spécifique doit rester strictement plus
 *     longue que son fourre-tout.
 */

/** `DEFAULT_CONTEXT_LENGTHS` de `agent/model_metadata.py`, à l'identique. */
const CONTEXT_LENGTHS: ReadonlyArray<readonly [string, number]> = [
  // Anthropic. Identifiants nus seulement : un identifiant préfixé se résout
  // en amont par OpenRouter / models.dev et entrerait en collision.
  ["claude-fable-5", 1_000_000], ["claude-fable", 1_000_000],
  ["claude-opus-5", 1_000_000], ["claude-sonnet-5", 1_000_000],
  ["claude-opus-4-8", 1_000_000], ["claude-opus-4.8", 1_000_000],
  ["claude-opus-4-7", 1_000_000], ["claude-opus-4.7", 1_000_000],
  ["claude-opus-4-6", 1_000_000], ["claude-sonnet-4-6", 1_000_000],
  ["claude-opus-4.6", 1_000_000], ["claude-sonnet-4.6", 1_000_000],
  ["claude", 200_000],
  // OpenAI, fenêtres de l'API directe.
  ["gpt-6-astra", 1_050_000],
  ["gpt-5.6-luna", 1_050_000], ["gpt-5.6-terra", 1_050_000], ["gpt-5.6-sol", 1_050_000],
  ["gpt-5.5", 1_050_000],
  ["gpt-5.4-nano", 400_000], ["gpt-5.4-mini", 400_000], ["gpt-5.4", 1_050_000],
  ["gpt-5.3-codex-spark", 128_000], ["gpt-5.1-chat", 128_000], ["gpt-5", 400_000],
  ["gpt-4.1", 1_047_576], ["gpt-4", 128_000],
  // Google, Gemma.
  ["gemini", 1_048_576],
  ["gemma-4", 256_000], ["gemma4", 256_000], ["gemma-4-31b", 256_000],
  ["gemma-3", 131_072], ["gemma", 8_192],
  // DeepSeek.
  ["deepseek-v4-pro", 1_000_000], ["deepseek-v4-flash", 1_000_000],
  ["deepseek-chat", 1_000_000], ["deepseek-reasoner", 1_000_000], ["deepseek", 128_000],
  // Meta, Muse Spark, Inkling.
  ["llama", 131_072], ["muse-spark-1.3", 1_048_576], ["muse-spark", 1_048_576],
  ["inkling", 1_048_576],
  // Qwen.
  ["qwen3.8-max", 1_000_000], ["qwen3.8-flash", 1_000_000],
  ["qwen3.6-plus", 1_048_576], ["qwen3.7-plus", 1_048_576],
  ["qwen3-coder-plus", 1_000_000], ["qwen3-coder", 262_144], ["qwen3-max", 262_144],
  ["qwen", 131_072],
  // MiniMax.
  ["minimax-m3", 1_000_000], ["minimax", 204_800],
  // GLM. La variante `:free` est plafonnée, et sa clé plus longue l'emporte.
  ["glm-5.2", 1_048_576], ["glm-5.2:free", 256_000], ["glm-5.3", 1_048_576], ["glm", 202_752],
  // xAI. `/v1/models` ne rend aucun `context_length` chez eux.
  ["grok-composer", 200_000], ["grok-build-latest", 500_000], ["grok-build", 256_000],
  ["grok-code-fast", 256_000], ["grok-2-vision", 8_192],
  ["grok-4-fast", 2_000_000], ["grok-4.20", 2_000_000],
  ["grok-4.6", 500_000], ["grok-4.5", 500_000], ["grok-4.3", 1_000_000], ["grok-4", 256_000],
  ["grok-3", 131_072], ["grok-2", 131_072], ["grok", 131_072],
  // Kimi.
  ["kimi-k3", 1_048_576], ["kimi", 262_144],
  // Upstage Solar.
  ["solar-open2", 262_144], ["solar-pro3", 131_072], ["solar-pro2", 65_536], ["solar-mini", 32_768],
  // Tencent Hunyuan.
  ["hy4-preview", 1_048_576], ["hy3-preview", 262_144], ["hy3", 262_144],
  // Divers : Ox Alpha, Nemotron, Laguna, Trinity, Elephant.
  ["x-preview-f", 1_048_576], ["ox-alpha", 1_048_576],
  ["nemotron-3.5-lightning", 1_000_000], ["nemotron", 131_072],
  ["laguna-s-2.1", 262_144], ["laguna-xs-2.1", 262_144], ["trinity", 262_144], ["elephant", 262_144],
  // Hugging Face Inference Providers : identifiants `org/nom`.
  ["qwen/qwen3.5-397b-a17b", 131_072], ["qwen/qwen3.5-35b-a3b", 131_072],
  ["deepseek-ai/deepseek-v3.2", 65_536],
  ["moonshotai/kimi-k2.5", 262_144], ["moonshotai/kimi-k2.6", 262_144],
  ["moonshotai/kimi-k2-thinking", 262_144],
  ["minimaxai/minimax-m2.5", 204_800], ["xiaomimimo/mimo-v2-flash", 262_144],
  ["mimo-v2-pro", 1_048_576], ["mimo-v2.5-pro", 1_048_576], ["mimo-v2.5", 1_048_576],
  ["mimo-v2-omni", 262_144], ["mimo-v2-flash", 262_144],
  ["zai-org/glm-5", 202_752],
];

/** Clé la plus longue d'abord : `gpt-5.4-mini` doit battre `gpt-5`. */
const BY_LONGEST_KEY = [...CONTEXT_LENGTHS].sort(([left], [right]) => right.length - left.length);

/**
 * Le plafond dur de l'amont quand la détection échoue
 * (`CONTEXT_PROBE_TIERS[0]`). Il est délibérément haut : l'amont préfère une
 * fenêtre trop grande, que l'API refusera, à une fenêtre trop petite qui
 * tronquerait la conversation en silence.
 */
export const DEFAULT_CONTEXT_WINDOW = 256_000;

/**
 * La fenêtre de contexte connue pour ce modèle, ou `null` si le nom est vide.
 *
 * Un modèle absent de la table ne rend PAS `null` : il rend le défaut de
 * l'amont, parce que c'est exactement ce que l'agent applique dans ce cas.
 * L'appelant n'utilise ce chiffre que lorsque le runtime n'a rien su dire :
 * un runtime qui répond porte l'override de configuration de son hôte, que
 * cette table ignore par construction.
 */
export function fallbackContextWindow(model: string | null | undefined): number | null {
  const id = (model ?? "").trim().toLowerCase();
  if (!id) return null;
  return BY_LONGEST_KEY.find(([key]) => id.includes(key))?.[1] ?? DEFAULT_CONTEXT_WINDOW;
}

/** `true` quand la fenêtre vient du défaut dur, pas d'une entrée nommée. */
export function isDefaultContextWindow(model: string | null | undefined): boolean {
  const id = (model ?? "").trim().toLowerCase();
  if (!id) return false;
  return !BY_LONGEST_KEY.some(([key]) => id.includes(key));
}
