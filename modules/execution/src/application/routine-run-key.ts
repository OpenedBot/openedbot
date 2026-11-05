import { isUuid } from "@openedbot/contracts-primitives";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * La clé de run de `routine_manage` : ce qui dit À L'API quel bot appelle.
 *
 * Le serveur MCP est unique par runtime (un profil clone la config racine,
 * un serveur par bot fuirait vers les bots créés ensuite) : son jeton prouve
 * le runtime, pas le bot. Le worker signe donc l'id du run qu'il exécute avec
 * le secret qu'il partage déjà avec l'API (`WORKER_INTERNAL_TOKEN`), le bot
 * la recopie dans ses appels, et l'API retrouve le run, son bot, son statut
 * et son origine (une routine ne crée pas de routine). Aucun aller-retour en
 * base pour la signer : rien de plus sur le chemin critique du run.
 *
 * La clé ne vaut que pour un run vivant : une fois le run terminé, l'API la
 * refuse, même bien signée.
 */
const ROUTINE_KEY_LABEL = "openedbot:routine-run-key:v1";

function mac(secret: string, runId: string, label: string): string {
  const key = createHmac("sha256", secret).update(label).digest();
  return createHmac("sha256", key).update(runId.toLowerCase()).digest("base64url").slice(0, 32);
}

export function signRoutineRunKey(secret: string, runId: string): string {
  return signRunKeyWithLabel(secret, runId, ROUTINE_KEY_LABEL);
}

/** L'id du run si la clé est bien signée, `null` sinon. */
export function readRoutineRunKey(secret: string, key: string): string | null {
  return readRunKeyWithLabel(secret, key, ROUTINE_KEY_LABEL);
}

/** Sign a run key for one named purpose. Labels keep tool keys isolated. */
export function signRunKeyWithLabel(secret: string, runId: string, label: string): string {
  return `${runId}.${mac(secret, runId, label)}`;
}

/** Read a run key only when it was signed for the same purpose label. */
export function readRunKeyWithLabel(secret: string, key: string, label: string): string | null {
  const [runId, signature, extra] = key.trim().split(".");
  if (!runId || !signature || extra !== undefined || !isUuid(runId)) return null;
  const expected = Buffer.from(mac(secret, runId, label));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  return runId;
}
