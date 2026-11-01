/** Read-only, metadata-only projection of the host's pinned A2A Agent Card. */
export type A2aAgentCard = {
  name: string;
  description: string;
  url: string;
  version: string;
  supportedInterfaces: Array<{ url: string; protocolBinding: "JSONRPC"; protocolVersion: "1.0" | "1.0.0" }>;
  capabilities: { streaming: boolean; pushNotifications: boolean };
  skills: Array<{ id: string; name: string; description?: string; tags?: string[] }>;
};
