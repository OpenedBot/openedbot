import {
  BOT_TOOL_POLICY_MAX_PER_WRITE,
  BOT_TOOL_POLICY_VALUES,
  isBotToolPolicyAlwaysRefused,
  isBotToolPolicyKey,
  type BotToolPolicyValue,
  type BotToolPolicyWrite,
} from "@openedbot/contracts-api";
import { HttpError } from "@openedbot/contracts-errors/http-error";

/**
 * The body of `PATCH /api/bots/:botId/tool-policies`:
 * `{ policies: [{ toolKey, policy }] }`, 1 to 64 entries, each key once.
 * Only the keys listed change; `inherit` returns a tool to the mode.
 */
export function readToolPolicyWrites(body: Record<string, unknown>): BotToolPolicyWrite[] {
  const list = body.policies;
  if (!Array.isArray(list) || list.length === 0 || list.length > BOT_TOOL_POLICY_MAX_PER_WRITE) {
    throw new HttpError(400, "TOOL_POLICIES_INVALID", `Envoyez entre 1 et ${BOT_TOOL_POLICY_MAX_PER_WRITE} politiques d’outil.`);
  }
  const seen = new Set<string>();
  return list.map((entry) => {
    const record = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : null;
    const toolKey = typeof record?.toolKey === "string" ? record.toolKey : "";
    const policy = record?.policy;
    if (!isBotToolPolicyKey(toolKey)) {
      throw new HttpError(400, "TOOL_POLICY_KEY_INVALID", "Cet outil ne peut pas recevoir de politique.");
    }
    if (typeof policy !== "string" || !(BOT_TOOL_POLICY_VALUES as readonly string[]).includes(policy)) {
      throw new HttpError(400, "TOOL_POLICY_INVALID", "La politique d’outil est invalide.");
    }
    if (policy === "always" && isBotToolPolicyAlwaysRefused(toolKey)) {
      throw new HttpError(400, "TOOL_POLICY_ALWAYS_OPAQUE", "Une opération opaque ne peut pas être mise en Toujours : elle demande toujours un humain hors Accès complet.");
    }
    if (seen.has(toolKey)) throw new HttpError(400, "TOOL_POLICIES_INVALID", "Un même outil figure deux fois.");
    seen.add(toolKey);
    return { toolKey, policy: policy as BotToolPolicyValue };
  });
}
