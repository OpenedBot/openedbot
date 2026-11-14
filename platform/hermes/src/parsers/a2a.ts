import type { A2aAgentCard } from "@openedbot/contracts-connector";
import { record, responseInvalid } from "./shared";

/** Re-project the host response at the Cloud boundary; raw or unknown fields never escape. */
export function parseA2aAgentCard(value: unknown): A2aAgentCard {
  const invalid = () => responseInvalid("La carte A2A du runtime est invalide.");
  const text = (value: unknown, maximum: number, required = true): string => {
    if (typeof value !== "string") throw invalid();
    const result = value.trim();
    if ((required && !result) || new TextEncoder().encode(result).length > maximum || /[\u0000-\u001f\u007f-\u009f]/u.test(result)) throw invalid();
    return result;
  };
  const url = (value: unknown) => {
    const result = text(value, 512);
    try {
      const parsed = new URL(result);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw invalid();
      return parsed.toString();
    } catch { throw invalid(); }
  };
  const card = record(value);
  if (!card || !Array.isArray(card.supportedInterfaces) || card.supportedInterfaces.length < 1
    || card.supportedInterfaces.length > 8 || !Array.isArray(card.skills) || card.skills.length > 64) throw invalid();
  const interfaces = card.supportedInterfaces.map((item: unknown): A2aAgentCard["supportedInterfaces"][number] => {
    const iface = record(item);
    if (!iface || iface.protocolBinding !== "JSONRPC" || typeof iface.protocolVersion !== "string"
      || !["1.0", "1.0.0"].includes(iface.protocolVersion)) throw invalid();
    return { url: url(iface.url), protocolBinding: "JSONRPC", protocolVersion: iface.protocolVersion as "1.0" | "1.0.0" };
  });
  const skills = card.skills.map((item: unknown) => {
    const skill = record(item);
    if (!skill || (skill.tags !== undefined && (!Array.isArray(skill.tags) || skill.tags.length > 16))) throw invalid();
    return { id: text(skill.id, 96), name: text(skill.name, 120),
      ...(skill.description === undefined ? {} : { description: text(skill.description, 256, false) }),
      ...(skill.tags === undefined ? {} : { tags: (skill.tags as unknown[]).map((tag) => text(tag, 64)) }) };
  });
  const capabilities = record(card.capabilities);
  if (!capabilities || typeof capabilities.streaming !== "boolean" || typeof capabilities.pushNotifications !== "boolean") throw invalid();
  return { name: text(card.name, 120), description: text(card.description, 512, false), url: url(card.url),
    version: text(card.version, 64), supportedInterfaces: interfaces, skills,
    capabilities: { streaming: capabilities.streaming, pushNotifications: capabilities.pushNotifications } };
}
