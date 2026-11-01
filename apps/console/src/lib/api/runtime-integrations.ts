import { activeFleetId, activeOrganizationId } from "../cloud-session";
import type { ConnectorReleaseResponse, RuntimeConfigurationDto, RuntimeGatewayRestartDto, RuntimeGatewayStatusDto, RuntimeIntegrationInventoryDto, RuntimeIntegrationMcpDto, RuntimeIntegrationMcpServerDto, RuntimeIntegrationToolsetStateDto, RuntimeMcpDisconnectDto, RuntimeMcpOauthDto } from "@openedbot/contracts-api";
import { request, sharedRead } from "./http";

export const runtimeIntegrationsApi = {
  /** Le runtime cloud et les capacités du déploiement. */
  runtimeConfiguration: () =>
    sharedRead(`runtime:${activeOrganizationId() ?? ""}:${activeFleetId() ?? ""}`, () => request<RuntimeConfigurationDto>("/api/runtime")),
  /** Inventaire administrateur des outils déclarés par Hermes. */
  /**
   * L'inventaire du runtime. Sans `fresh`, l'API peut rendre son instantané
   * (cache serveur) ; « Actualiser » demande une vraie relecture de l'hôte.
   */
  runtimeIntegrations: (fresh = false) =>
    request<RuntimeIntegrationInventoryDto>(`/api/runtime/integrations${fresh ? "?fresh=1" : ""}`),
  /**
   * Serveurs MCP de l'hôte et catalogue approuvé.
   *
   * Route séparée de l'inventaire : elle démarre un interpréteur sur l'hôte, et
   * seul le panneau des connecteurs en a besoin. Elle n'est donc lue que quand
   * ce panneau est monté.
   */
  runtimeMcp: () => request<RuntimeIntegrationMcpDto>("/api/runtime/integrations/mcp"),
  /** Le panneau d'administration prouve ses écritures en relisant : il saute le cache serveur de 30 s. */
  runtimeMcpFresh: () => request<RuntimeIntegrationMcpDto>("/api/runtime/integrations/mcp?fresh=1"),
  /**
   * Active ou désactive un toolset sur l'hôte du runtime.
   *
   * L'état rendu est celui que l'hôte a RELU sur son inventaire : `applied`
   * peut valoir `false` alors que l'appel a réussi, et c'est ce cas-là qu'il
   * faut montrer plutôt qu'un succès qui n'a pas eu lieu.
   */
  setRuntimeToolset: (name: string, enabled: boolean) =>
    request<RuntimeIntegrationToolsetStateDto>(
      `/api/runtime/integrations/toolsets/${encodeURIComponent(name)}`,
      { method: "POST", body: JSON.stringify({ enabled }) },
    ),
  /** Ajoute un serveur MCP https sur l'hôte. Le jeton part dans le corps, jamais dans l'URL. */
  addRuntimeMcpServer: (input: {
    name: string;
    url: string;
    auth: "none" | "header" | "oauth";
    token?: string;
    replace?: boolean;
  }) =>
    request<RuntimeIntegrationMcpServerDto>("/api/runtime/integrations/mcp/servers", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  /** Installe une entrée du catalogue approuvé porté par l'hôte. */
  installRuntimeMcpCatalogEntry: (name: string, env: Record<string, string> = {}) =>
    request<RuntimeIntegrationMcpServerDto>(
      `/api/runtime/integrations/mcp/catalog/${encodeURIComponent(name)}`,
      { method: "POST", body: JSON.stringify({ env }) },
    ),
  /** Retire un serveur MCP de l'hôte. */
  removeRuntimeMcpServer: (name: string) =>
    request<void>(`/api/runtime/integrations/mcp/servers/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
  /**
   * Ouvre l'autorisation OAuth d'un serveur MCP sur l'hôte. La session rendue
   * porte l'URL du fournisseur à ouvrir dans un onglet ; le retour passe par
   * l'API, jamais par ce composant.
   */
  startRuntimeMcpOauth: (name: string) =>
    request<RuntimeMcpOauthDto>(`/api/runtime/integrations/mcp/servers/${encodeURIComponent(name)}/oauth`, {
      method: "POST",
      body: "{}",
    }),
  /**
   * « Connecter » une entrée du catalogue d'openedbot à UN bot : l'API ajoute
   * le serveur à l'hôte s'il n'y est pas, puis ouvre son autorisation pour le
   * profil du bot. La session rendue se suit avec `runtimeMcpOauth`.
   */
  connectMcpConnector: (connectorId: string, botId: string) =>
    request<RuntimeMcpOauthDto>(`/api/runtime/integrations/mcp/connectors/${encodeURIComponent(connectorId)}/connect`, {
      method: "POST",
      body: JSON.stringify({ botId }),
    }),
  disconnectMcpConnector: (connectorId: string, botId: string) =>
    request<RuntimeMcpDisconnectDto>(
      `/api/runtime/integrations/mcp/connectors/${encodeURIComponent(connectorId)}/connections/${encodeURIComponent(botId)}`,
      { method: "DELETE" },
    ),
  runtimeMcpOauth: (name: string, sessionId: string) =>
    request<RuntimeMcpOauthDto>(
      `/api/runtime/integrations/mcp/servers/${encodeURIComponent(name)}/oauth/${encodeURIComponent(sessionId)}`,
    ),
  cancelRuntimeMcpOauth: (name: string, sessionId: string) =>
    request<void>(
      `/api/runtime/integrations/mcp/servers/${encodeURIComponent(name)}/oauth/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
    ),
  /** L'état du gateway de l'hôte : un redémarrage est-il en attente. */
  runtimeGateway: () => request<RuntimeGatewayStatusDto>("/api/runtime/integrations/gateway"),
  /** Le seul redémarrage que le lien porte, rendu comme un job à suivre. */
  restartRuntimeGateway: () =>
    request<RuntimeGatewayRestartDto>("/api/runtime/integrations/gateway/restart", { method: "POST", body: "{}" }),
  runtimeGatewayRestart: (jobId: string) =>
    request<RuntimeGatewayRestartDto>(`/api/runtime/integrations/gateway/restart/${encodeURIComponent(jobId)}`),
  /** La dernière release d’edge-setup, ses notes et l’accusé « vu » de ce membre. */
  connectorRelease: () => request<ConnectorReleaseResponse>("/api/runtimes/connector-release"),
  markConnectorReleaseSeen: (version: string) =>
    request<void>("/api/runtimes/connector-release/seen", { method: "POST", body: JSON.stringify({ version }) }),
};
