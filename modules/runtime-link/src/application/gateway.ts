import { HermesClient, createRelayTransport } from "@openedbot/hermes";
import {
  decodeTextFrame,
  RELAY_CLOSE_PROBE_FAILED,
  RELAY_CLOSE_UNAUTHORIZED,
  RELAY_FEATURE_CREATION_AUDIT_V2,
  RELAY_MAX_FEATURES,
  RELAY_MAX_RESPONSE_BODY,
  type RelayLinkContextFrame,
  type RelayTextFrame, type YoloLeaseKey,
} from "@openedbot/contracts-connector";
import type { ApiConfig } from "@openedbot/platform-config/api-config";
import type { Db } from "@openedbot/platform-db";
import { withCredential, withTenant } from "@openedbot/platform-db";
import { constantTimeEqual, hashCredential, randomCredential } from "@openedbot/platform-db/credential";
import { consumeRuntimeEnrollment } from "@openedbot/runtimes/sql/runtime-enrollments";
import {
  insertConnectorRuntime,
  registerLinkDevicePublicKey,
  writeLinkAgent,
  writeLinkOrigin,
} from "@openedbot/runtimes/sql/runtime-link-rows";
import { enrolledRuntimeActivation } from "./enroll-activation";
import { insertRuntimeLinkEvent } from "./link-persistence";
import {
  type LinkConnection,
  type LinkIdentity,
  type LinkLogger,
  type LinkPeer,
  type RuntimeLinkBroker,
} from "./broker";
import { auditKeyFrame, ensureAuditKey } from "./audit-keys";
import { enqueueConnectorUpgradeNotice } from "./connector-notices";
import { devTunnelWsUrl, expectedLinkWsUrls, LINK_POP_TIMEOUT_MS, linkPopNonce, linkSignedOrigin, verifyLinkProof } from "./link-pop";
import { RUNTIME_LINK_WS_PATH } from "../domain/ws-path";
import {
  RUNTIME_LINK_INTERNAL_PREFIX,
  RUNTIME_LINK_RELAY_HOP_HEADER,
  RUNTIME_LINK_RELAY_STAGE_HEADER,
} from "./instances";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { API_RATE_RULES, createRateLimitGate, requestClientIp, RUNTIME_LINK_UPGRADE_RULE, type RateLimitGate } from "@openedbot/platform-config/rate-limit";
import { enrollmentState, readEnrollmentRow } from "@openedbot/runtimes/application/runtime-enrollment";
import { probeRuntimeCapacityWith } from "@openedbot/runtimes/application/runtime-probe";
import { readAllRuntimeRows } from "@openedbot/runtimes/sql/runtime-rows";
import { lockRuntimeDeclarations } from "@openedbot/runtimes/sql/runtime-replacement";
import { logEvent } from "@openedbot/platform-observability";
import { runtimeConnector } from "@openedbot/platform-config/connector-version";

/**
 * La montée WebSocket du lien connecteur. Le relais interne vers le worker
 * vit à côté, dans `internal-relay.ts`.
 *
 * La montée est servie dans `Bun.serve.fetch` AVANT Hono : l'authentification
 * (ticket d'enrôlement ou jeton de lien) précède `server.upgrade`, un `GET`
 * sans `Upgrade` répond 426, et aucune route Hono ne connaît ce chemin.
 * Cycle de vie complet : `docs/CONNECTOR.md` côté `edge-setup`.
 */
export { RUNTIME_LINK_WS_PATH };
export const RUNTIME_LINK_SUBPROTOCOL = "hermes-connector.v1";
export {
  RUNTIME_LINK_INTERNAL_PREFIX,
  RUNTIME_LINK_RELAY_HOP_HEADER,
  RUNTIME_LINK_RELAY_STAGE_HEADER,
};
/** `hello` doit être la première trame, et arriver vite. */
export const RUNTIME_LINK_HELLO_TIMEOUT_MS = 10_000;
/** La sonde d'enrôlement à travers le tuyau, bornée. */
export const RUNTIME_LINK_PROBE_TIMEOUT_MS = 30_000;

/**
 * Options `websocket` de `Bun.serve`, à côté des handlers.
 *
 * `closeOnBackpressureLimit` : à 1 MiB de file non écrite, Bun ferme le lien
 * plutôt que d'abandonner des messages (`send` → 0). Mieux vaut un lien fermé
 * (le run est classé `ambiguous`, le worker le dit) qu'un corps de
 * `POST /v1/runs` tronqué, clos par un `end` propre, et exécuté tel quel.
 */
export const RUNTIME_LINK_WEBSOCKET_OPTIONS = {
  idleTimeout: 60,
  maxPayloadLength: RELAY_MAX_RESPONSE_BODY + 4,
  backpressureLimit: 1024 * 1024,
  closeOnBackpressureLimit: true,
  sendPings: true,
} as const;

export type LinkEnrollment = {
  id: string;
  organizationId: string;
  runtimeName: string;
};

export type LinkCredential =
  | {
      kind: "link";
      identity: LinkIdentity;
      /** `runtimes.link_device_pubkey` : présente, la session doit prouver la possession de la clé. */
      registeredDeviceKey?: string | null;
    }
  | { kind: "enrollment"; enrollment: LinkEnrollment };

/** Le défi de possession en cours : le nonce, la clé attendue, et son inscription ou remplacement. */
export type LinkPopState = {
  nonce: string;
  devicePublicKey: string;
  firstKey: boolean;
  rekey: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

export type LinkSocketData = {
  credential: LinkCredential;
  /** L'adresse vue à la montée (celle du rate limit) et le `User-Agent` : journal du lien, règle hijack. */
  peer: LinkPeer;
  state: "awaiting_hello" | "awaiting_proof" | "provisional" | "binding" | "bound";
  connection: LinkConnection | null;
  helloTimer: ReturnType<typeof setTimeout> | null;
  pop?: LinkPopState | null;
  /** Hors production : `ws://127.0.0.1:<port>` du tunnel composé (en-tête `Host`), voir devTunnelWsUrl. */
  devTunnelWsUrl?: string | null;
};

/** Ce qu'un enrôlement réussi produit : l'identité liée ET le jeton, remis une seule fois à l'hôte. */
export type IssuedLink = { identity: LinkIdentity; linkToken: string };

export type LinkEnroller = (
  connection: LinkConnection,
  enrollment: LinkEnrollment,
  signal: AbortSignal,
) => Promise<IssuedLink>;

export type RuntimeLinkGatewayDependencies = {
  db: Db;
  config: ApiConfig;
  broker: RuntimeLinkBroker;
  gate?: RateLimitGate;
  /** Remplaçable dans les tests ; par défaut `enrollConnectorRuntime`. */
  enroll?: LinkEnroller;
  helloTimeoutMs?: number;
  probeTimeoutMs?: number;
  /** Délai accordé à `link.proof` (défaut 10 s). */
  popTimeoutMs?: number;
  /** Les URL WebSocket qu'une preuve peut nommer (défaut : dérivées de la configuration). */
  wsUrls?: string[];
  log?: LinkLogger;
  leaseKeys?: YoloLeaseKey[]; // Mode YOLO : `link.context.leaseKeys` (`yoloLinkLeaseKeys`, link-yolo.ts).
};

type UpgradeServer = {
  upgrade(request: Request, options: { data: LinkSocketData; headers?: Record<string, string> }): boolean;
  requestIP?: (request: Request) => { address: string } | null;
};

type LinkWebSocket = {
  data: LinkSocketData;
  /** Le verdict de Bun : -1 en file, 0 abandonné, > 0 écrit (voir `LinkSocket`). */
  send(data: string | Uint8Array): number;
  close(code?: number, reason?: string): void;
  ping?(data?: string | Uint8Array): number;
};

export type RuntimeLinkGateway = {
  /** `undefined` quand la montée a eu lieu ; sinon la réponse HTTP à rendre. */
  handleUpgrade(request: Request, server: UpgradeServer): Promise<Response | undefined>;
  websocket: {
    open(ws: LinkWebSocket): void;
    message(ws: LinkWebSocket, message: string | ArrayBufferView | ArrayBuffer): void;
    close(ws: LinkWebSocket, code: number, reason: string): void;
    pong(ws: LinkWebSocket, data?: Uint8Array): void;
  };
};

function jsonError(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

/**
 * `Authorization: Bearer enrollment:<id>.<secret>` ou `Bearer link:<runtimeId>.<token>`.
 * Rien d'autre n'ouvre le lien : ni session, ni cookie.
 */
export function parseLinkAuthorization(header: string | null): { scheme: "enrollment" | "link"; id: string; secret: string } | null {
  if (!header?.startsWith("Bearer ")) return null;
  const value = header.slice(7).trim();
  if (!value || value.length > 1_024) return null;
  const colon = value.indexOf(":");
  if (colon <= 0) return null;
  const scheme = value.slice(0, colon);
  if (scheme !== "enrollment" && scheme !== "link") return null;
  const rest = value.slice(colon + 1);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot === rest.length - 1) return null;
  const id = rest.slice(0, dot);
  const secret = rest.slice(dot + 1);
  if (!/^[0-9a-f-]{36}$/i.test(id) || secret.length > 512) return null;
  return { scheme, id, secret };
}

export function createRuntimeLinkGateway(deps: RuntimeLinkGatewayDependencies): RuntimeLinkGateway {
  const { db, config, broker } = deps;
  const gate = deps.gate ?? createRateLimitGate({ [RUNTIME_LINK_UPGRADE_RULE]: API_RATE_RULES[RUNTIME_LINK_UPGRADE_RULE]! });
  const enroll = deps.enroll ?? ((connection, enrollment, signal) =>
    enrollConnectorRuntime({ db, config, instanceId: broker.instanceId }, connection, enrollment, signal));
  const helloTimeoutMs = deps.helloTimeoutMs ?? RUNTIME_LINK_HELLO_TIMEOUT_MS;
  const probeTimeoutMs = deps.probeTimeoutMs ?? RUNTIME_LINK_PROBE_TIMEOUT_MS;
  const popTimeoutMs = deps.popTimeoutMs ?? LINK_POP_TIMEOUT_MS;
  const wsUrls = deps.wsUrls ?? expectedLinkWsUrls(config);
  const log = deps.log ?? logEvent;

  async function handleUpgrade(request: Request, server: UpgradeServer): Promise<Response | undefined> {
    if (request.method !== "GET") {
      return jsonError(405, "METHOD_NOT_ALLOWED", "Le lien connecteur se monte en GET.", { Allow: "GET" });
    }
    const upgrade = request.headers.get("upgrade")?.toLowerCase() ?? "";
    if (upgrade !== "websocket") {
      return jsonError(426, "UPGRADE_REQUIRED", "Ce chemin n'accepte qu'une montée WebSocket.", {
        Upgrade: "websocket",
        Connection: "Upgrade",
      });
    }
    const ip = requestClientIp(request, server, config.trustProxy);
    const verdict = gate.check("GET", RUNTIME_LINK_WS_PATH, ip);
    if (verdict.limited) {
      return jsonError(429, "RATE_LIMITED", "Trop de tentatives. Réessayez plus tard.", {
        "Retry-After": String(verdict.retryAfterSeconds),
      });
    }
    const offered = request.headers.get("sec-websocket-protocol");
    const protocols = offered ? offered.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
    if (protocols.length > 0 && !protocols.includes(RUNTIME_LINK_SUBPROTOCOL)) {
      return jsonError(400, "LINK_PROTOCOL_UNSUPPORTED", `Le lien connecteur parle ${RUNTIME_LINK_SUBPROTOCOL}.`);
    }
    const authorization = parseLinkAuthorization(request.headers.get("authorization"));
    if (!authorization) {
      return jsonError(401, "LINK_AUTH_REQUIRED", "Le lien exige un ticket d'enrôlement ou un jeton de lien.");
    }

    let credential: LinkCredential;
    if (authorization.scheme === "link") {
      const tokenHash = hashCredential(authorization.secret);
      // Le hash courant, ou le précédent tant que sa grâce de rotation court
      // (0027) : un hôte qui n'a pas encore reçu `link.rotate` se reconnecte.
      const row = await withCredential(db, tokenHash, async (tx) => {
        const rows = await tx<Array<{ id: string; organizationId: string; isCurrent: boolean; previousExpiresAt: Date | string | null; deviceKey: string | null }>>`
          select id, organization_id as "organizationId",
                 link_token_hash = ${tokenHash} as "isCurrent",
                 link_token_previous_expires_at as "previousExpiresAt",
                 link_device_pubkey as "deviceKey"
            from runtimes
           where reachability = 'connector' and revoked_at is null
             and (
               link_token_hash = ${tokenHash}
               or (link_token_previous_hash = ${tokenHash} and link_token_previous_expires_at > now())
             )
           limit 1
        `;
        return rows[0] ?? null;
      });
      if (!row || !constantTimeEqual(row.id, authorization.id)) {
        return jsonError(401, "LINK_AUTH_INVALID", "Jeton de lien refusé.");
      }
      // Ancien jeton : la connexion porte sa date de fin, le broker la fermera 4401.
      const expiresAt = row.isCurrent || !row.previousExpiresAt ? null : new Date(row.previousExpiresAt).getTime();
      credential = {
        kind: "link",
        identity: { runtimeId: row.id, organizationId: row.organizationId, tokenHash, expiresAt },
        registeredDeviceKey: row.deviceKey ?? null,
      };
    } else {
      const secretHash = hashCredential(authorization.secret);
      const row = await withCredential(db, secretHash, async (tx) => {
        const rows = await readEnrollmentRow(tx, secretHash);
        return rows[0] ?? null;
      });
      if (!row || !constantTimeEqual(row.id, authorization.id)) {
        return jsonError(401, "LINK_AUTH_INVALID", "Ticket d'enrôlement refusé.");
      }
      const state = enrollmentState(row);
      if (state === "expired") return jsonError(410, "ENROLLMENT_EXPIRED", "Cet enrôlement a expiré.");
      if (state === "completed") return jsonError(409, "ENROLLMENT_CONSUMED", "Cet enrôlement a déjà été utilisé.");
      if (state === "pending" || !row.organizationId) {
        return jsonError(409, "ENROLLMENT_UNCLAIMED", "Cet enrôlement n'a pas encore été confirmé.");
      }
      if (row.reachability !== "connector") {
        return jsonError(409, "ENROLLMENT_REACHABILITY_MISMATCH", "Cet enrôlement attend une URL, pas un lien.");
      }
      if (broker.enrollmentInProgress(row.id)) {
        return jsonError(409, "ENROLLMENT_BUSY", "Une sonde est déjà en cours pour cet enrôlement.");
      }
      credential = {
        kind: "enrollment",
        enrollment: { id: row.id, organizationId: row.organizationId, runtimeName: row.runtimeName },
      };
    }

    const agent = request.headers.get("user-agent");
    const data: LinkSocketData = {
      credential,
      peer: { ip: ip || null, agent: agent ? agent.slice(0, 256) : null },
      state: "awaiting_hello",
      connection: null,
      helloTimer: null,
      devTunnelWsUrl: devTunnelWsUrl(config, request.headers.get("host")),
    };
    const upgraded = server.upgrade(request, {
      data,
      ...(protocols.length > 0 ? { headers: { "Sec-WebSocket-Protocol": RUNTIME_LINK_SUBPROTOCOL } } : {}),
    });
    if (!upgraded) return jsonError(400, "UPGRADE_FAILED", "La montée WebSocket a échoué.");
    return undefined;
  }

  function clearHelloTimer(ws: LinkWebSocket): void {
    if (ws.data.helloTimer) clearTimeout(ws.data.helloTimer);
    ws.data.helloTimer = null;
  }

  function clearPopTimer(ws: LinkWebSocket): void {
    if (ws.data.pop?.timer) clearTimeout(ws.data.pop.timer);
    if (ws.data.pop) ws.data.pop.timer = null;
  }

  /**
   * La liaison, puis, si l'hôte a annoncé `creation_audit_v2`, la clé
   * d'audit. Les clés sont lues AVANT `bind` : dès l'admission le broker
   * peut router une `req`, et la trame `audit.key` doit la précéder sur le
   * fil. Elle part dans la continuation même de l'admission, sans attendre
   * la base entre les deux.
   */
  async function beginBound(ws: LinkWebSocket, connection: LinkConnection, identity: LinkIdentity): Promise<void> {
    ws.data.state = "binding";
    const audited = connection.features.includes(RELAY_FEATURE_CREATION_AUDIT_V2);
    const keys = audited
      ? await withCredential(db, identity.tokenHash, (tx) => ensureAuditKey(tx, identity.organizationId, identity.runtimeId, config.tokenEncryption))
      : null;
    await broker.bind(connection, identity, ws.data.peer);
    if (connection.isClosed) return;
    ws.data.state = "bound";
    if (keys) {
      // La clé part ici, à chaque session, jamais en HTTP ni dans un journal.
      connection.sendFrame(auditKeyFrame(identity.runtimeId, keys));
      log("runtime_link.audit_key_sent", { runtimeId: identity.runtimeId, keyId: keys.current.keyId, previous: keys.previous.length });
    }
    if (ws.data.credential.kind === "link") await recordLinkAgent(ws, connection, connection.link!);
    await sendLinkContext(connection, identity);
  }

  /** L'agent n'est retenu qu'après admission ; ce signalement ne ferme jamais le lien. */
  async function recordLinkAgent(ws: LinkWebSocket, connection: LinkConnection, identity: LinkIdentity): Promise<void> {
    const agent = connection.agent?.slice(0, 256);
    if (agent === undefined) return;
    const connector = runtimeConnector(agent, null, config.connectorVersions);
    if (connector?.outdated && connector.minimumVersion) {
      const meta = { ip: ws.data.peer.ip, agent, minimum: connector.minimumVersion };
      broker.journal(identity, "agent_outdated", meta);
      log("runtime_link.agent_outdated", { runtimeId: identity.runtimeId, ...meta });
    }
    try {
      await withCredential(db, identity.tokenHash, async (tx) => {
        await writeLinkAgent(tx, identity, { agent, generation: connection.link?.generation ?? null });
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

  /**
   * `link.context` : quel openedbot est derrière ce lien : palier, origine, organisation et son
   * propriétaire (le membre `owner` le plus ancien). L'hôte le nomme dans ses alertes Discord et son
   * `status`, et l'enrôlement l'écrit dans `link.json` : la trame précède `link.issued`. Données
   * d'affichage, sauf `limits` (la borne des features que l'API applique à `hello` et `capabilities`,
   * pour que l'hôte n'en liste jamais plus, `docs/CONNECTOR.md`, « Borne des features ») et `leaseKeys`
   * (les clés de bail YOLO que l'hôte épingle). Un échec est journalisé, jamais fatal ; un hôte plus
   * ancien ignore la trame, ou ses champs qu'il ne connaît pas.
   */
  async function sendLinkContext(connection: LinkConnection, identity: LinkIdentity): Promise<void> {
    const frame: RelayLinkContextFrame = {
      t: "link.context",
      environment: config.deployEnvironment,
      // L'origine du lien, pas celle de la PWA : un hôte >= v0.5.7 la suit
      // seul quand elle partage le domaine parent (`connector.MovedWSURL`).
      ohb: config.linkPublicUrl ?? config.publicUrl,
      // La borne que `decodeTextFrame` applique à `hello` et `capabilities` : l'hôte
      // la retient (persistée avec le contexte) pour dimensionner son prochain `hello`.
      limits: { features: RELAY_MAX_FEATURES },
      ...(deps.leaseKeys?.length ? { leaseKeys: deps.leaseKeys } : {}),
    };
    if (config.connectorVersions.latestVersion) frame.latestVersion = config.connectorVersions.latestVersion;
    if (config.connectorVersions.minimumVersion) frame.minimumVersion = config.connectorVersions.minimumVersion;
    try {
      const rows = await withTenant(db, identity.organizationId, (tx) => tx<Array<{ id: string; name: string; slug: string; email: string | null; displayName: string | null }>>`
        select o.id, o.name, o.slug, u.email, u.display_name as "displayName"
        from organizations o
        left join memberships m on m.organization_id = o.id and m.role = 'owner'
        left join users u on u.id = m.user_id
        where o.id = ${identity.organizationId}
        order by m.created_at asc nulls last
        limit 1
      `);
      const row = rows[0];
      if (row) {
        frame.organization = { id: row.id, name: row.name, slug: row.slug };
        if (row.email) frame.owner = { email: row.email, ...(row.displayName ? { displayName: row.displayName } : {}) };
      }
    } catch (error) {
      log("runtime_link.context_lookup_failed", { runtimeId: identity.runtimeId, error: String(error) });
    }
    if (connection.isClosed) return;
    connection.sendFrame(frame);
    log("runtime_link.context_sent", { runtimeId: identity.runtimeId, environment: frame.environment, owner: frame.owner?.email ?? null });
  }

  /**
   * Preuve de possession : ce que la session doit prouver, ou rien.
   *
   *   - clé enregistrée, aucune offerte : l'hôte signe avec la clé enregistrée ;
   *   - clé offerte égale à l'enregistrée : idem ;
   *   - première clé offerte : seulement sous le jeton COURANT, et enregistrée
   *     après la preuve de possession ;
   *   - clé offerte différente (rekey) : seulement sous le jeton COURANT, et
   *     la preuve se fait avec la nouvelle clé, qui remplace l'ancienne ;
   *   - aucune des deux : en production (`RUNTIME_LINK_REQUIRE_POP`) refus,
   *     ailleurs liaison avec `pop_missing` au journal.
   */
  function decidePop(ws: LinkWebSocket, connection: LinkConnection, identity: LinkIdentity, registered: string | null): "bind" | "challenge" | "refuse" {
    const offered = connection.devicePublicKey;
    if (!registered && !offered) {
      if (config.linkSecurity.requirePop) {
        broker.journal(identity, "pop_failed", { ip: ws.data.peer.ip, agent: connection.agent ?? ws.data.peer.agent, reason: "no_device_key" });
        return "refuse";
      }
      broker.journal(identity, "pop_missing", { ip: ws.data.peer.ip, agent: connection.agent ?? ws.data.peer.agent });
      return "bind";
    }
    const firstKey = registered === null;
    const rekey = Boolean(registered && offered && offered !== registered);
    if ((firstKey || rekey) && identity.expiresAt !== null) {
      // Un ancien jeton en grâce ne peut ni inscrire ni changer la clé de la machine.
      broker.journal(identity, "pop_failed", { ip: ws.data.peer.ip, agent: connection.agent ?? ws.data.peer.agent, reason: firstKey ? "first_key_with_previous_token" : "rekey_with_previous_token" });
      return "refuse";
    }
    ws.data.pop = { nonce: linkPopNonce(), devicePublicKey: (offered ?? registered)!, firstKey, rekey, timer: null };
    return "challenge";
  }

  function refusePop(ws: LinkWebSocket, identity: LinkIdentity, reason: string): void {
    clearPopTimer(ws);
    const connection = ws.data.connection;
    broker.journal(identity, "pop_failed", { ip: ws.data.peer.ip, agent: connection?.agent ?? ws.data.peer.agent, reason });
    log("runtime_link.pop_failed", { runtimeId: identity.runtimeId, reason });
    ws.data.pop = null;
    (connection ?? ws).close(RELAY_CLOSE_UNAUTHORIZED, "LINK_POP_FAILED");
  }

  function sendChallenge(ws: LinkWebSocket, connection: LinkConnection, identity: LinkIdentity): void {
    const pop = ws.data.pop!;
    ws.data.state = "awaiting_proof";
    pop.timer = setTimeout(() => {
      if (ws.data.state === "awaiting_proof") refusePop(ws, identity, "timeout");
    }, popTimeoutMs);
    connection.sendFrame({ t: "link.challenge", nonce: pop.nonce });
  }

  async function acceptProof(ws: LinkWebSocket, connection: LinkConnection, identity: LinkIdentity, signature: string): Promise<void> {
    const pop = ws.data.pop;
    if (!pop) return refusePop(ws, identity, "no_challenge");
    const accepted = ws.data.devTunnelWsUrl && !wsUrls.includes(ws.data.devTunnelWsUrl) ? [...wsUrls, ws.data.devTunnelWsUrl] : wsUrls;
    const signedUrl = verifyLinkProof({ devicePublicKey: pop.devicePublicKey, nonce: pop.nonce, runtimeId: identity.runtimeId, signature, wsUrls: accepted });
    if (!signedUrl) return refusePop(ws, identity, pop.rekey ? "rekey_signature" : "signature");
    clearPopTimer(ws);
    ws.data.pop = null;
    // La preuve est acquise : quitter `awaiting_proof` tout de suite. Les
    // écritures ci-dessous sont asynchrones, et un hôte qui envoie une trame
    // juste derrière `link.proof` la verrait sinon prise pour une preuve
    // manquante (`proof_expected`, 4401) : mesuré 2026-10-13, edge-setup
    // v0.5.10 derrière la passerelle séparée, refusé à chaque montée.
    ws.data.state = "binding";
    if (pop.firstKey || pop.rekey) {
      // Si le jeton a tourné (ou le runtime a été révoqué) entre le défi et
      // la preuve, l'UPDATE ne touche aucune ligne : la clé n'est pas
      // enregistrée, donc ni succès journalisé ni admission.
      const persisted = await withCredential(db, identity.tokenHash, async (tx) => {
        return registerLinkDevicePublicKey(tx, identity, pop.devicePublicKey);
      });
      if (!persisted) return refusePop(ws, identity, pop.firstKey ? "first_key_not_persisted" : "rekey_not_persisted");
      if (pop.firstKey) {
        broker.journal(identity, "device_key_registered", { ip: ws.data.peer.ip, agent: connection.agent ?? ws.data.peer.agent });
        log("runtime_link.device_key_registered", { runtimeId: identity.runtimeId });
      } else {
        broker.journal(identity, "rotated", { ip: ws.data.peer.ip, agent: connection.agent ?? ws.data.peer.agent, reason: "device_key" });
        log("runtime_link.device_key_rotated", { runtimeId: identity.runtimeId });
      }
    }
    log("runtime_link.pop_verified", { runtimeId: identity.runtimeId, wsUrl: signedUrl, rekey: pop.rekey });
    const origin = linkSignedOrigin(signedUrl);
    if (origin) {
      // La session continue même si l'écriture rate : l'origine sert à l'écran,
      // pas à l'admission. Une lecture ratée ne doit pas couper un lien valide.
      try {
        await withCredential(db, identity.tokenHash, (tx) => writeLinkOrigin(tx, identity, origin));
      } catch (error) {
        log("runtime_link.origin_not_stored", { runtimeId: identity.runtimeId, code: error instanceof Error ? error.name : "unknown" });
      }
    }
    await beginBound(ws, connection, identity);
  }

  async function beginProvisional(ws: LinkWebSocket, connection: LinkConnection, enrollment: LinkEnrollment): Promise<void> {
    if (!broker.beginEnrollment(enrollment.id)) {
      connection.close(RELAY_CLOSE_UNAUTHORIZED, "ENROLLMENT_BUSY");
      return;
    }
    ws.data.state = "provisional";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("probe_timeout"), probeTimeoutMs);
    try {
      const issued = await enroll(connection, enrollment, controller.signal);
      if (connection.isClosed) return;
      await beginBound(ws, connection, issued.identity);
      if (connection.isClosed) return;
      // Le jeton part ici, une seule fois, jamais en HTTP ni dans un journal.
      connection.sendFrame({ t: "link.issued", runtimeId: issued.identity.runtimeId, linkToken: issued.linkToken });
      connection.expectEnrollmentBye = true;
      log("runtime_link.enrolled", { enrollmentId: enrollment.id, runtimeId: issued.identity.runtimeId });
    } catch (error) {
      const code = error instanceof HttpError ? error.code : "LINK_PROBE_FAILED";
      const message = error instanceof HttpError ? error.message : "La sonde d'enrôlement a échoué.";
      log("runtime_link.enrollment_failed", { enrollmentId: enrollment.id, code });
      // `err` porte un identifiant de requête par contrat ; la sonde n'en a plus
      // en vol, le code de fermeture 4003 est ce que l'hôte lit vraiment.
      connection.sendFrame({ t: "err", id: 1, code, message, stage: "before_dispatch" });
      connection.close(RELAY_CLOSE_PROBE_FAILED, "LINK_PROBE_FAILED");
    } finally {
      clearTimeout(timer);
      broker.endEnrollment(enrollment.id);
    }
  }

  const websocket: RuntimeLinkGateway["websocket"] = {
    open(ws) {
      ws.data.helloTimer = setTimeout(() => {
        if (ws.data.state === "awaiting_hello") ws.close(RELAY_CLOSE_UNAUTHORIZED, "HELLO_REQUIRED");
      }, helloTimeoutMs);
    },
    message(ws, message) {
      if (ws.data.state === "awaiting_hello") {
        let frame: RelayTextFrame;
        try {
          if (typeof message !== "string") throw new Error("binary before hello");
          frame = decodeTextFrame(message);
        } catch {
          clearHelloTimer(ws);
          ws.close(RELAY_CLOSE_UNAUTHORIZED, "HELLO_REQUIRED");
          return;
        }
        if (frame.t !== "hello") {
          clearHelloTimer(ws);
          ws.close(RELAY_CLOSE_UNAUTHORIZED, "HELLO_REQUIRED");
          return;
        }
        clearHelloTimer(ws);
        const connection = broker.open(ws);
        connection.agent = frame.agent ?? null;
        // Ce que l'hôte sait faire, tel qu'il l'a dit : rien de plus.
        connection.features = frame.features ?? [];
        connection.devicePublicKey = frame.devicePublicKey ?? null;
        ws.data.connection = connection;
        if (ws.data.credential.kind === "link") {
          const { identity, registeredDeviceKey } = ws.data.credential;
          const decision = decidePop(ws, connection, identity, registeredDeviceKey ?? null);
          if (decision === "refuse") {
            connection.close(RELAY_CLOSE_UNAUTHORIZED, "LINK_POP_FAILED");
            return;
          }
          if (decision === "challenge") {
            sendChallenge(ws, connection, identity);
            return;
          }
          void beginBound(ws, connection, identity).catch(() => {
            connection.close(1012, "LINK_ADMISSION_FAILED");
          });
        }
        else void beginProvisional(ws, connection, ws.data.credential.enrollment);
        return;
      }
      const connection = ws.data.connection;
      if (!connection) return;
      if (ws.data.state === "awaiting_proof" && ws.data.credential.kind === "link") {
        const identity = ws.data.credential.identity;
        let frame: RelayTextFrame | null = null;
        try {
          if (typeof message === "string") frame = decodeTextFrame(message);
        } catch {
          frame = null;
        }
        if (!frame || frame.t !== "link.proof") {
          refusePop(ws, identity, "proof_expected");
          return;
        }
        void acceptProof(ws, connection, identity, frame.signature).catch(() => {
          connection.close(1012, "LINK_ADMISSION_FAILED");
        });
        return;
      }
      if (typeof message === "string") {
        let frame: RelayTextFrame;
        try {
          frame = decodeTextFrame(message);
        } catch (error) {
          log("runtime_link.frame_ignored", { runtimeId: connection.link?.runtimeId ?? null, error: String(error) });
          return;
        }
        connection.handleText(frame);
        return;
      }
      const bytes = message instanceof ArrayBuffer
        ? new Uint8Array(message)
        : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
      connection.handleBinary(bytes);
    },
    close(ws, code, reason) {
      clearHelloTimer(ws);
      clearPopTimer(ws);
      const connection = ws.data.connection;
      if (connection) broker.release(connection, code, reason);
    },
    pong(ws, data) {
      ws.data.connection?.handlePong(data);
    },
  };

  return { handleUpgrade, websocket };
}

/**
 * L'enrôlement par le lien : sonde À TRAVERS le tuyau, puis une seule
 * transaction : insertion du runtime `connector`, ticket brûlé, organisation
 * en `external`. Le jeton de lien naît ici et ne sort que par `link.issued`.
 */
export async function enrollConnectorRuntime(
  context: { db: Db; config: ApiConfig; instanceId: string },
  connection: LinkConnection,
  enrollment: LinkEnrollment,
  signal: AbortSignal,
): Promise<IssuedLink> {
  const client = new HermesClient({
    transport: createRelayTransport({
      runtimeId: `enrollment:${enrollment.id}`,
      dial: (request, requestSignal) => connection.dispatch(request, anySignal(signal, requestSignal)),
    }),
  });
  const capacity = await probeRuntimeCapacityWith(client);
  if (signal.aborted) throw new HttpError(504, "LINK_PROBE_TIMEOUT", "La sonde d'enrôlement a dépassé son délai.");

  const linkToken = randomCredential(32);
  const tokenHash = hashCredential(linkToken);
  const runtimeId = crypto.randomUUID();
  const organizationId = enrollment.organizationId;
  await withTenant(context.db, organizationId, async (tx) => {
    // Même verrou que les autres déclarations : le ticket a pu être ouvert
    // avant qu'un autre remplaçant soit déclaré.
    await lockRuntimeDeclarations(tx, organizationId);
    const existing = await readAllRuntimeRows(tx, organizationId);
    let { active, retireId } = enrolledRuntimeActivation(existing);
    if (retireId) {
      // Le WHERE rejoue la condition : un lien rouvert entre la lecture et
      // l'écriture n'est pas retiré, et le nouveau runtime reste en attente
      // de remplacement. L'ancien est RÉVOQUÉ, pas seulement désactivé : une
      // organisation n'a qu'un runtime, et un connecteur mort gardé vivant
      // devenait un second runtime que plus aucune bascule ne rattrape.
      const cleared = await tx`
        update runtimes set revoked_at = now(), is_active = false, updated_at = now()
         where organization_id = ${organizationId} and id = ${retireId}
           and is_active and reachability = 'connector' and link_connected_at is null
        returning id
      `;
      if (cleared.length === 0) active = false;
      else await insertRuntimeLinkEvent(tx, organizationId, retireId, "revoked");
    }
    // Une organisation n'a qu'un runtime : un remplaçant de plus ne s'ajoute
    // pas à celui qui attend déjà. Le rollback laisse le ticket intact.
    if (!active && existing.some((row) => !row.isActive)) {
      throw new HttpError(409, "RUNTIME_REPLACEMENT_PENDING", "Un runtime attend déjà de remplacer l’actuel : terminez ce remplacement ou retirez-le d’abord.");
    }
    // La clé device annoncée dans `hello` est enregistrée avec le runtime :
    // dès la session suivante, le jeton seul ne suffit plus.
    await insertConnectorRuntime(tx, {
      runtimeId,
      organizationId,
      name: enrollment.runtimeName,
      tokenHash,
      instanceId: context.instanceId,
      features: connection.features,
      capacity,
      active,
      devicePublicKey: connection.devicePublicKey,
    });
    // Le secret est effacé en même temps que l'enrôlement est consommé : la
    // ligne reste pour l'audit, mais plus rien ne la rouvre.
    const burned = await consumeRuntimeEnrollment(tx, { enrollmentId: enrollment.id, organizationId, runtimeId });
    if (!burned) {
      throw new HttpError(409, "ENROLLMENT_CONSUMED", "Cet enrôlement a déjà été utilisé.");
    }
    await tx`
      update organizations set runtime_mode = 'external', updated_at = now()
       where id = ${organizationId}
    `;
  });
  return { identity: { runtimeId, organizationId, tokenHash, expiresAt: null }, linkToken };
}

function anySignal(primary: AbortSignal, secondary?: AbortSignal): AbortSignal {
  if (!secondary) return primary;
  const controller = new AbortController();
  const forward = (signal: AbortSignal) => () => controller.abort(signal.reason);
  if (primary.aborted) controller.abort(primary.reason);
  else primary.addEventListener("abort", forward(primary), { once: true });
  if (secondary.aborted) controller.abort(secondary.reason);
  else secondary.addEventListener("abort", forward(secondary), { once: true });
  return controller.signal;
}
