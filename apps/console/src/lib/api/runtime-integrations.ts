import { activeOrganizationId } from "../session/cloud-session";
import type { ConnectorReleaseResponse, RuntimeConfigurationDto, RuntimeGatewayRestartDto, RuntimeGatewayStatusDto, RuntimeIntegrationInventoryDto, RuntimeIntegrationMcpDto, RuntimeIntegrationMcpServerDto, RuntimeIntegrationToolsetStateDto, RuntimeMcpDisconnectDto, RuntimeMcpOauthDto } from "@openedbot/contracts-api";
import { request, sharedRead } from "./http";

export const runtimeIntegrationsApi = {
  /** The cloud runtime and the deployment's capabilities. */
  runtimeConfiguration: () =>
    sharedRead(`runtime:${activeOrganizationId() ?? ""}`, () => request<RuntimeConfigurationDto>("/api/runtime")),
  /** Administrator inventory of the tools declared by Hermes. */
  /**
   * The runtime's inventory. Without `fresh`, the API may return its snapshot
   * (server cache); « Actualiser » asks for a real reread of the host.
   */
  runtimeIntegrations: (fresh = false) =>
    request<RuntimeIntegrationInventoryDto>(`/api/runtime/integrations${fresh ? "?fresh=1" : ""}`),
  /**
   * The host's MCP servers and the approved catalog.
   *
   * A route separate from the inventory: it starts an interpreter on the host, and
   * only the connectors panel needs it. It is therefore read only when
   * that panel is mounted.
   */
  runtimeMcp: () => request<RuntimeIntegrationMcpDto>("/api/runtime/integrations/mcp"),
  /** The admin panel proves its writes by rereading: it skips the 30 s server cache. */
  runtimeMcpFresh: () => request<RuntimeIntegrationMcpDto>("/api/runtime/integrations/mcp?fresh=1"),
  /**
   * Enables or disables a toolset on the runtime's host.
   *
   * The returned state is what the host REREAD on its inventory: `applied`
   * can be `false` even though the call succeeded, and that is the case
   * to show rather than a success that did not happen.
   */
  setRuntimeToolset: (name: string, enabled: boolean) =>
    request<RuntimeIntegrationToolsetStateDto>(
      `/api/runtime/integrations/toolsets/${encodeURIComponent(name)}`,
      { method: "POST", body: JSON.stringify({ enabled }) },
    ),
  /** Adds an https MCP server on the host. The token goes in the body, never in the URL. */
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
  /** Installs an entry of the approved catalog carried by the host. */
  installRuntimeMcpCatalogEntry: (name: string, env: Record<string, string> = {}) =>
    request<RuntimeIntegrationMcpServerDto>(
      `/api/runtime/integrations/mcp/catalog/${encodeURIComponent(name)}`,
      { method: "POST", body: JSON.stringify({ env }) },
    ),
  /** Removes an MCP server from the host. */
  removeRuntimeMcpServer: (name: string) =>
    request<void>(`/api/runtime/integrations/mcp/servers/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
  /**
   * Opens the OAuth authorization of an MCP server on the host. The returned session
   * carries the provider URL to open in a tab; the return goes through
   * the API, never through this component. `replacePending`: the operator
   * chose to cancel the authorization already in progress for this server
   * (409 `MCP_OAUTH_IN_PROGRESS`) and start this one.
   */
  startRuntimeMcpOauth: (name: string, options: { replacePending?: boolean } = {}) =>
    request<RuntimeMcpOauthDto>(`/api/runtime/integrations/mcp/servers/${encodeURIComponent(name)}/oauth`, {
      method: "POST",
      body: JSON.stringify(options.replacePending ? { replacePending: true } : {}),
    }),
  /**
   * « Connecter » an openedbot catalog entry to ONE bot: the API adds
   * the server to the host if it is not there, then opens its authorization for the
   * bot's profile. The returned session is followed with `runtimeMcpOauth`.
   */
  connectMcpConnector: (connectorId: string, botId: string, options: { replacePending?: boolean } = {}) =>
    request<RuntimeMcpOauthDto>(`/api/runtime/integrations/mcp/connectors/${encodeURIComponent(connectorId)}/connect`, {
      method: "POST",
      body: JSON.stringify(options.replacePending ? { botId, replacePending: true } : { botId }),
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
  /** The host gateway's state: is a restart pending. */
  runtimeGateway: () => request<RuntimeGatewayStatusDto>("/api/runtime/integrations/gateway"),
  /** The only restart the link carries, returned as a job to follow. */
  restartRuntimeGateway: () =>
    request<RuntimeGatewayRestartDto>("/api/runtime/integrations/gateway/restart", { method: "POST", body: "{}" }),
  runtimeGatewayRestart: (jobId: string) =>
    request<RuntimeGatewayRestartDto>(`/api/runtime/integrations/gateway/restart/${encodeURIComponent(jobId)}`),
  /** The latest edge-setup release, its notes and this member's « vu » acknowledgement. */
  connectorRelease: () => request<ConnectorReleaseResponse>("/api/runtimes/connector-release"),
  markConnectorReleaseSeen: (version: string) =>
    request<void>("/api/runtimes/connector-release/seen", { method: "POST", body: JSON.stringify({ version }) }),
};
