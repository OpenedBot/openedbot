/**
 * Pure helpers of `make link-dev-up`: what the local side decides before it
 * touches the tunnel, the local API or the VPS. Nothing here does I/O beyond
 * reading the hostname (injectable), so the decisions are unit-tested without a VPS.
 */
import { hostname } from "node:os";

export type LinkDevEnv = Record<string, string | undefined>;

export type LinkDevPlan = {
  /** `embedded` (the API carries the link) or `separate` (dedicated listener). */
  mode: "embedded" | "separate";
  /** Loopback port on the VPS the connector dials; one per instance, see workstationPort. */
  remotePort: number;
  /** Loopback port on the workstation the tunnel forwards to. */
  localPort: number;
  /** Health path of the forwarded service, probed before the tunnel opens. */
  healthPath: "/api/health" | "/health";
  /** Port of the local API used for login and enrollment (always the API). */
  apiPort: number;
  /** Origin the connector links to, as seen from the VPS. */
  remoteOrigin: string;
  /** Connector instance on the VPS; `default` is the slot that flips modes. */
  instance: string;
  /** Display name of the enrolled runtime in the local openedbot. */
  runtimeName: string;
};

const INSTANCE = /^[a-z][a-z0-9-]{0,31}$/u;

function port(value: string | undefined, fallback: number, label: string): number {
  const text = (value ?? "").trim();
  if (text === "") return fallback;
  if (!/^\d{1,5}$/u.test(text)) throw new Error(`${label} invalide : ${text}`);
  const parsed = Number(text);
  if (parsed < 1 || parsed > 65535) throw new Error(`${label} hors limites : ${text}`);
  return parsed;
}

/** Names `edge-setup` keeps for itself (`layout.reservedConnectorInstances`). */
const RESERVED_INSTANCES = new Set(["default", "runs", "diagnostics", "creation-audit"]);

/** Loopback range on the VPS the per-workstation tunnel ports are drawn from. */
export const WORKSTATION_PORT_BASE = 8800;
export const WORKSTATION_PORT_SPAN = 100;

/**
 * This workstation's connector instance on the VPS, from its hostname.
 *
 * Every workstation used to default to the same `mac` instance on the same
 * VPS port: the second one to link found the port held by the first one's
 * live tunnel and looped on `remote port forwarding failed`. Naming the
 * instance after the machine gives each workstation its own slot with no
 * setting at all. `Dev-MacBook-Pro.local` becomes `dev-macbook-pro`.
 */
export function workstationInstance(machine: string): string {
  const slug = machine.trim().split(".")[0]!.toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-").replace(/-+/gu, "-").replace(/^-+|-+$/gu, "");
  let name = /^[a-z]/u.test(slug) ? slug : `poste-${slug}`.replace(/-+$/u, "");
  if (RESERVED_INSTANCES.has(name)) name = `poste-${name}`;
  name = name.slice(0, 32).replace(/-+$/u, "");
  return INSTANCE.test(name) ? name : "poste";
}

/**
 * Stable VPS loopback port of an instance (FNV-1a of its name in a 100-port
 * range): two workstations land on two ports, and the same one always lands
 * on the same port, so its link is reused without a ticket. A collision is
 * caught before the tunnel opens (the port answers for another machine) and
 * fixed with LINK_TUNNEL_PORT in `.env.local`.
 */
export function workstationPort(instance: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(instance)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return WORKSTATION_PORT_BASE + (hash % WORKSTATION_PORT_SPAN);
}

/**
 * Port arithmetic of the reverse SSH tunnel, plus what the enrollment needs.
 *
 * `default` is allowed and is the point of the switch: since `edge-setup
 * link` replaces the link of whichever instance it targets, that one slot is
 * flipped between a development openedbot and production. Any other
 * instance keeps both links alive at once. Without LINK_DEV_INSTANCE the
 * instance is named after the workstation (`workstationInstance`), so an
 * unqualified run never takes production over and two workstations never
 * share a slot. Without LINK_TUNNEL_PORT the VPS port follows the instance.
 */
export function planLinkDev(env: LinkDevEnv, options: { instance?: string; runtimeName?: string; hostname?: string } = {}): LinkDevPlan {
  const modeRaw = (env.RUNTIME_LINK_MODE ?? "embedded").trim();
  if (modeRaw !== "embedded" && modeRaw !== "separate") throw new Error(`RUNTIME_LINK_MODE invalide : ${modeRaw}`);
  const apiPort = port(env.API_PORT, 8790, "API_PORT");
  const localPort = modeRaw === "separate"
    ? port(env.LINK_TUNNEL_LOCAL_PORT, port(env.RUNTIME_LINK_PORT, 8791, "RUNTIME_LINK_PORT"), "LINK_TUNNEL_LOCAL_PORT")
    : port(env.LINK_TUNNEL_LOCAL_PORT, apiPort, "LINK_TUNNEL_LOCAL_PORT");
  const explicit = (options.instance ?? env.LINK_DEV_INSTANCE ?? "").trim();
  const instance = explicit || workstationInstance(options.hostname ?? hostname());
  if (instance !== "default" && !INSTANCE.test(instance)) throw new Error(`Nom d'instance invalide : ${instance} (attendu ${INSTANCE.source})`);
  const remotePort = port(env.LINK_TUNNEL_PORT, workstationPort(instance), "LINK_TUNNEL_PORT");
  return {
    mode: modeRaw,
    remotePort,
    localPort,
    healthPath: modeRaw === "separate" ? "/health" : "/api/health",
    apiPort,
    // 127.0.0.1, never `localhost`: on the VPS that name resolves to ::1 first,
    // and the tunnel only binds the IPv4 loopback.
    remoteOrigin: `http://127.0.0.1:${remotePort}`,
    instance,
    runtimeName: (options.runtimeName ?? env.LINK_DEV_RUNTIME_NAME ?? `${instance} (poste)`).trim(),
  };
}

export type RemoteConnector = {
  name: string;
  active?: boolean;
  link_present?: boolean;
  openedbot?: string;
  runtime_id?: string;
  device_key_sealed?: boolean;
};

/**
 * Reads `edge-setup status --json` and says whether the instance is already
 * linked to this tunnel origin. Linked: the connector reconnects by itself
 * once the tunnel is up, so no ticket is spent. Linked elsewhere: this ticket
 * takes the instance over, and the operator is told which openedbot is
 * left holding a runtime the VPS will no longer dial.
 */
export function remoteLinkState(statusJson: unknown, plan: LinkDevPlan): "linked" | "absent" | "elsewhere" {
  const connectors = (statusJson as { connectors?: RemoteConnector[] } | null)?.connectors;
  if (!Array.isArray(connectors)) throw new Error("`edge-setup status --json` ne liste pas `connectors` : mettre le VPS à niveau (edge-setup upgrade).");
  const instance = connectors.find((connector) => connector?.name === plan.instance);
  if (!instance || !instance.link_present) return "absent";
  return instance.openedbot?.replace(/\/+$/u, "") === plan.remoteOrigin ? "linked" : "elsewhere";
}

/**
 * The argv run on the VPS, ticket on stdin: it never travels in argv.
 *
 * `default` takes no `--name`: it is the instance `edge-setup link` targets
 * when none is given. No `--replace` either, since re-linking always replaces
 * the link of the instance it targets.
 */
export function remoteLinkCommand(plan: LinkDevPlan): string[] {
  const argv = ["sudo", "-n", "edge-setup", "link", "--openedbot", plan.remoteOrigin, "--yes", "--insecure-openedbot"];
  if (plan.instance !== "default") argv.push("--name", plan.instance);
  return argv;
}

/**
 * Restart of the connector unit that already holds this link. The connector
 * doubles its reconnect delay up to 60 s while the local API is down (measured
 * 2026-10-06: 33 s between the tunnel opening and the next dial); it cannot
 * know the tunnel just came back. A restart starts again at 1 s. Named
 * instances run as `hermes-connector@<name>.service`, `default` as
 * `hermes-connector.service`.
 */
export function remoteConnectorRestartCommand(plan: LinkDevPlan): string[] {
  const unit = plan.instance === "default" ? "hermes-connector.service" : `hermes-connector@${plan.instance}.service`;
  return ["sudo", "-n", "systemctl", "restart", unit];
}

/**
 * argv that runs a shell script on the VPS as ONE `sh -c` argument.
 *
 * ssh joins its remote argv with spaces and the remote login shell parses the
 * result again, so `["sh", "-c", script]` arrived split on every space: the
 * first word ran as the script and the rest as positional parameters (the old
 * stale-forward cleanup never killed anything for that reason). The script is
 * single-quoted for that second parse.
 */
export function remoteShell(script: string): string[] {
  return ["sh", "-c", `'${script.replaceAll("'", `'\\''`)}'`];
}

/**
 * Dev credentials of the local API: the seeded account unless overridden. No
 * password is versioned: E2E_PASSWORD is generated into .env.local by
 * `make setup` (or the first `make db-seed`).
 */
export function localCredentials(env: LinkDevEnv): { email: string; password: string } {
  const email = (env.LINK_DEV_EMAIL ?? env.E2E_EMAIL ?? "dev@openedbot.local").trim();
  const password = env.LINK_DEV_PASSWORD ?? env.E2E_PASSWORD ?? "";
  if (!email || !password) throw new Error("LINK_DEV_EMAIL / LINK_DEV_PASSWORD (ou E2E_*) sont vides : make setup génère E2E_PASSWORD dans .env.local.");
  return { email, password };
}

/**
 * `separate` mode keeps the link listener in a long-lived user service that
 * does not reload on file changes, unlike `bun --watch` for the API. After a
 * merge it silently serves the old protocol (seen: handshake 500 on a column
 * the new code expects). Say so before opening the tunnel.
 */
export function gatewayStaleness(input: {
  gatewayStartedAtMs: number | null;
  headCommittedAtMs: number;
  migrationMtimesMs: number[];
}): string[] {
  const hints: string[] = [];
  if (input.gatewayStartedAtMs === null) return hints;
  if (input.gatewayStartedAtMs < input.headCommittedAtMs) {
    hints.push("la passerelle de lien (openedbot-runtime-link-gateway) a démarré avant le dernier commit : systemctl --user restart openedbot-runtime-link-gateway");
  }
  if (input.migrationMtimesMs.some((mtime) => mtime > input.gatewayStartedAtMs!)) {
    hints.push("des migrations sont plus récentes que la passerelle : make db-migrate, puis relancer la passerelle");
  }
  return hints;
}
