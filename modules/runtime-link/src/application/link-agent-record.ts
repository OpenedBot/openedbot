import type { ApiConfig } from "@openedbot/platform-config/api-config";
import { runtimeConnector } from "@openedbot/platform-config/connector-version";
import { withCredential, withTenant, type Db } from "@openedbot/platform-db";
import { writeLinkAgent } from "@openedbot/runtimes/sql/runtime-link-rows";
import { enqueueConnectorUpgradeNotice } from "./connector-notices";
import type { LinkConnection, LinkIdentity, LinkLogger, RuntimeLinkBroker } from "./broker";

/** Borne de `runtimes.link_hermes_version` (0162) : une version, jamais un texte libre. */
const HERMES_VERSION_MAX = 64;

export type LinkAgentRecordDeps = {
  db: Db;
  config: Pick<ApiConfig, "connectorVersions" | "webUrl">;
  broker: Pick<RuntimeLinkBroker, "journal">;
  log: LinkLogger;
};

/**
 * Ce que `hello` a déclaré (`agent`, `hermesVersion`), retenu après admission
 * seulement ; ce signalement ne ferme jamais le lien. Un `hello` sans `agent`
 * ne touche à rien : la déclaration précédente reste. Sans `hermesVersion`,
 * la colonne repasse à null : la console ne compare alors rien.
 */
export async function recordLinkAgent(
  deps: LinkAgentRecordDeps,
  connection: LinkConnection,
  identity: LinkIdentity,
  hello: { peerIp: string | null; hermesVersion: string | null },
): Promise<void> {
  const { db, config, broker, log } = deps;
  const agent = connection.agent?.slice(0, 256);
  if (agent === undefined) return;
  const hermesVersion = hello.hermesVersion?.slice(0, HERMES_VERSION_MAX) ?? null;
  const connector = runtimeConnector(agent, null, config.connectorVersions);
  if (connector?.outdated && connector.minimumVersion) {
    const meta = { ip: hello.peerIp, agent, minimum: connector.minimumVersion };
    broker.journal(identity, "agent_outdated", meta);
    log("runtime_link.agent_outdated", { runtimeId: identity.runtimeId, ...meta });
  }
  try {
    await withCredential(db, identity.tokenHash, async (tx) => {
      await writeLinkAgent(tx, identity, { agent, hermesVersion, generation: connection.link?.generation ?? null });
    });
  } catch (error) {
    log("runtime_link.agent_write_failed", { runtimeId: identity.runtimeId, error: String(error) });
  }
  if (connector?.outdated && connector.version && connector.minimumVersion) {
    // Once per (runtime, installed, target): a reconnect loop finds the
    // notice already written. A failure is logged and never ends the link.
    const notice = {
      organizationId: identity.organizationId,
      runtimeId: identity.runtimeId,
      installedVersion: connector.version,
      targetVersion: connector.minimumVersion,
      latestVersion: connector.latestVersion,
      upgradeCommand: connector.upgradeCommand,
    };
    try {
      const queued = await withTenant(db, identity.organizationId, (tx) => enqueueConnectorUpgradeNotice(tx, notice, config.webUrl));
      if (queued.queued) {
        log("runtime_link.connector_notice_queued", {
          runtimeId: identity.runtimeId, installed: notice.installedVersion, target: notice.targetVersion, emails: queued.emails,
        });
      }
    } catch (error) {
      log("runtime_link.connector_notice_failed", { runtimeId: identity.runtimeId, error: String(error) });
    }
  }
}
