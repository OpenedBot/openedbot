/**
 * La fenêtre de contexte que le runtime applique au modèle configuré.
 *
 * `status` dit d'où vient le chiffre, et il n'y a pas de troisième cas : soit
 * l'hôte l'a lu (`ok`), soit personne ne l'a et l'appelant retombe sur sa
 * table locale. Le gateway Hermes ne publie ce nombre nulle part : ni
 * `/v1/models`, ni `/api/model/options`, ni `/v1/capabilities`. Seul un hôte
 * qui sert `edge-setup` peut le dire, parce que seul l'amont sait le
 * résoudre (`agent/model_metadata.py`).
 *
 * `contextWindow` vaut `0` quand elle est inconnue : jamais un plafond deviné.
 */
export type RuntimeModelContextDto = {
  runtimeId: string;
  status: "ok" | "unsupported" | "disconnected" | "error";
  reason: "feature_absent" | "link_closed" | null;
  model: string | null;
  provider: string | null;
  /** Ce que l'agent applique : l'override de config, sinon la valeur détectée. */
  contextWindow: number;
  /** La valeur détectée seule, quand un override la remplace. */
  autoContextWindow: number;
  maxOutputTokens: number;
  /**
   * Ce que le gateway place devant chaque run (identité, mémoire, index des
   * skills, schémas d'outils, serveurs MCP), mesuré sur l'hôte. `null` quand
   * l'hôte ne le publie pas encore : la barre n'a alors que la part d'openedbot.
   */
  preamble: ContextPreambleDto | null;
  fetchedAt: string | null;
  error: string | null;
};

/** Un poste du préambule ; `tokens: null` veut dire présent mais non mesuré, jamais zéro. */
export type ContextPreambleBucketDto = {
  key: "identity" | "memory" | "skills" | "tools" | "mcp";
  tokens: number | null;
  items: Array<{ name: string; tokens: number | null }>;
};

export type ContextPreambleDto = { buckets: ContextPreambleBucketDto[] };
