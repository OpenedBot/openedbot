/**
 * Trames du lien connecteur : contrat de fil partagé avec `edge-setup`
 * (`internal/connector/frames.go`). Les règles de validation sont celles de
 * `DecodeText` côté Go, et les vecteurs de
 * `platform/hermes/tests/fixtures/relay-frames.vectors.json`
 * sont identiques dans les deux dépôts : une divergence casse un test des deux
 * côtés.
 */

import { isUuid } from "./uuid";

/** Version du protocole annoncée dans `hello`. */
export const RELAY_PROTOCOL = 1 as const;

/** Bornes du contrat de fil. */
export const RELAY_MAX_IN_FLIGHT = 64;
export const RELAY_MAX_REQUEST_BODY = 1 << 20;
export const RELAY_MAX_RESPONSE_BODY = 4 << 20;
export const RELAY_MAX_HEADER_BYTES = 16 << 10;
export const RELAY_MAX_TEXT_FRAME = 64 << 10;
/** Secondes entre `req` et le premier `res`, sauf pour `/events`. */
export const RELAY_FIRST_RESPONSE_LIMIT_S = 60;

/** Codes de fermeture WebSocket. */
export const RELAY_CLOSE_TOO_BIG = 1009;
export const RELAY_CLOSE_REPLACED = 4001;
export const RELAY_CLOSE_PROBE_FAILED = 4003;
export const RELAY_CLOSE_REVOKED = 4004;
/** Ping WebSocket sans pong ni trame : openedbot raccroche, l'hôte redial (pas un refus). */
export const RELAY_CLOSE_RECONNECT = 4005;
export const RELAY_CLOSE_UNAUTHORIZED = 4401;

export type RelayErrStage = "before_dispatch" | "after_dispatch";

/** En-tête posé par le relais interne quand la réponse décrit une panne du LIEN, pas une réponse gateway. */
export const RELAY_STAGE_HEADER = "X-OHB-Relay-Stage";

/**
 * Capacité annoncée dans `hello.features` : l'hôte sert les quatre routes
 * `/hermes-setup/providers/…` (dépôt d'un credential fournisseur par le lien).
 * Toute capacité inconnue est ignorée, jamais refusée.
 */
export const RELAY_FEATURE_PROVIDER_MANAGEMENT = "provider_management";
/** L'hôte sert aussi la sonde strictement lecture seule `/hermes-setup/usage`. */
export const RELAY_FEATURE_PROVIDER_USAGE = "provider_usage";
/**
 * L'hôte sert `GET /hermes-setup/model-context` : la fenêtre de contexte que
 * ce runtime applique au modèle configuré. Le gateway ne la publie nulle part,
 * et un hôte plus ancien ne l'annonce pas : l'appelant retombe alors sur sa
 * propre table de fenêtres par modèle.
 */
export const RELAY_FEATURE_MODEL_CONTEXT = "model_context";
/**
 * L'hôte sert la lecture nommée des profils Hermes déjà présents
 * (`GET /hermes-setup/profiles` et l'avatar borné). Pas d'écriture de profil.
 */
export const RELAY_FEATURE_PROFILE_INVENTORY = "profile_inventory";
/**
 * Feature du LIEN (jamais de l'opérateur) : l'hôte tient un audit de création
 * scellé et attend `audit.key` avant de dispatcher une création
 * (`docs/CONNECTOR.md`, « Audit de création chiffré »).
 */
export const RELAY_FEATURE_CREATION_AUDIT_V2 = "creation_audit_v2";
/** L'hôte sert la mémoire d'un profil (`GET`/`POST /hermes-setup/profiles/{slug}/memory`) par le magasin amont. */
export const RELAY_FEATURE_PROFILE_MEMORY = "profile_memory";
/** L'hôte sert `GET /hermes-setup/sessions-inventory` (identifiants de session par profil, bornés). */
export const RELAY_FEATURE_SESSIONS_INVENTORY = "sessions_inventory";
/**
 * Bornes de `hello.features` et de `capabilities.features` : au plus 64
 * entrées, chacune `^[a-z0-9_]{1,64}$`. C'est la borne que l'API ANNONCE à
 * l'hôte dans `link.context.limits.features` : un `hello` plus long est refusé
 * 4401, que l'hôte lit comme un refus d'authentification.
 */
export const RELAY_MAX_FEATURES = 64;
/**
 * La borne de toute API publiée avant `limits.features`. Un hôte l'applique
 * tant qu'aucune borne ne lui a été annoncée (API plus ancienne, premier
 * démarrage) : un `hello` de plus de 16 noms y était refusé. À ne jamais relever.
 */
export const RELAY_DEFAULT_MAX_FEATURES = 16;
const FEATURE_PATTERN = /^[a-z0-9_]{1,64}$/;
/** `audit.key` remet la clé courante et au plus deux clés retirées encore lisibles. */
export const RELAY_MAX_AUDIT_PREVIOUS_KEYS = 2;
const AUDIT_KEY_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
const AUDIT_TAIL_PATTERN = /^[0-9a-f]{64}$/;
/** Une clé de 32 octets, un nonce de 32 octets ou une clé publique Ed25519 : base64 standard de 32 octets. */
const BASE64_32_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
/** Une signature Ed25519 : base64 standard de 64 octets. */
const BASE64_64_PATTERN = /^[A-Za-z0-9+/]{86}==$/;

export type RelayHelloFrame = {
  t: "hello";
  protocol: number;
  agent?: string;
  hermesVersion?: string;
  features?: string[];
  /**
   * Clé publique Ed25519 de la machine (base64, 32 octets), présentée à
   * chaque session par un hôte qui en a une. Le broker la vérifie par
   * `link.challenge` / `link.proof` avant de lier la connexion.
   */
  devicePublicKey?: string;
};
/** Le défi de possession : un nonce de 32 octets, base64, à signer. */
export type RelayLinkChallengeFrame = { t: "link.challenge"; nonce: string };
/** La preuve : signature Ed25519 (base64, 64 octets) du message de possession. */
export type RelayLinkProofFrame = { t: "link.proof"; signature: string };
/** Une clé maîtresse d'audit encore acceptée en lecture. */
export type RelayAuditKeyRef = { keyId: string; key: string };
/**
 * openedbot → hôte, juste après la liaison quand `hello.features` contient
 * `creation_audit_v2` : la clé maîtresse courante du runtime et les clés
 * retirées encore lisibles. Jamais journalisée.
 */
export type RelayAuditKeyFrame = { t: "audit.key"; runtimeId: string; keyId: string; key: string; previous?: RelayAuditKeyRef[] };
/** Hôte → openedbot après chaque écriture de l'audit : la position courante de la chaîne. */
export type RelayAuditAnchorFrame = {
  t: "audit.anchor";
  runtimeId: string;
  keyId: string;
  writeSeq: number;
  count: number;
  dropped: number;
  tail: string;
};
export type RelayDiagnosticFrame = {
  t: "diagnostic";
  eventId: string;
  component: "link" | "operator";
  state: "unavailable" | "recovered";
  code: string;
  occurredAt: string;
  message: string;
  stack?: string;
};
export type RelayDiagnosticAckFrame = { t: "diagnostic.ack"; eventId: string };
export type RelayCapabilitiesFrame = { t: "capabilities"; features?: string[] };
/**
 * Hôte → openedbot : l'inventaire de l'hôte (toolsets, MCP, skills) a bougé, ou
 * la session commence. Aucun champ ; envoyée seulement si `link.context.accepts`
 * la nomme.
 */
export type RelayInventoryChangedFrame = { t: "inventory.changed" };
/** Les trames facultatives de l'hôte que cette API comprend (`link.context.accepts`). */
export const RELAY_ACCEPTED_HOST_FRAMES = ["inventory.changed"] as const;
export type RelayLinkIssuedFrame = { t: "link.issued"; runtimeId: string; linkToken: string };
/**
 * Rotation du jeton de lien, poussée par openedbot sur un lien ouvert :
 * l'hôte remplace son jeton stocké et se reconnecte avec. L'ancien reste
 * accepté pendant la fenêtre de grâce côté SaaS. Même forme que `link.issued`.
 */
export type RelayLinkRotateFrame = { t: "link.rotate"; runtimeId: string; linkToken: string };
/**
 * Hôte → SaaS, sur un lien admis (preuve de possession faite) : l'hôte se
 * retire (`edge-setup uninstall`, `unlink`). Le SaaS révoque le runtime comme
 * l'aurait fait son propriétaire, répond `link.retired` puis ferme le lien
 * (4004). Aucun champ : l'identité est celle du lien.
 */
export type RelayLinkRetireFrame = { t: "link.retire" };
/** SaaS → hôte : le runtime nommé est révoqué ; son jeton n'ouvre plus rien. */
export type RelayLinkRetiredFrame = { t: "link.retired"; runtimeId: string };
/**
 * Le contexte du lien, poussé par openedbot juste après la liaison : quel
 * openedbot (palier, origine, organisation, propriétaire) est derrière
 * ce lien. Données d'affichage pour les alertes et le `status` de l'hôte,
 * jamais un secret. Un hôte plus ancien ignore la trame.
 */
export type RelayLinkContextEnvironment = "dev" | "preprod" | "prod";
/**
 * Les bornes que l'API applique à l'hôte. Une borne absente n'est pas
 * annoncée : l'hôte garde alors celle de toute API plus ancienne.
 */
export type RelayLinkContextLimits = {
  /** Nombre maximal de noms que l'API accepte dans `hello.features` et `capabilities.features`. */
  features?: number;
};
export type RelayLinkContextFrame = {
  t: "link.context";
  environment: RelayLinkContextEnvironment;
  ohb: string;
  organization?: { id: string; name: string; slug: string };
  owner?: { email: string; displayName?: string };
  /** Seuils informatifs openedbot ; les anciens hôtes ignorent ces champs. */
  latestVersion?: string;
  minimumVersion?: string;
  /**
   * Bornes de l'API, annoncées après la liaison. Un hôte plus ancien ignore le
   * champ, comme les seuils ci-dessus : `DecodeText` ne rejette pas les champs
   * inconnus, alors qu'une trame de plus aurait fini en « unknown frame type ».
   */
  limits?: RelayLinkContextLimits;
  /** Les trames facultatives de l'hôte que cette API comprend (une API plus ancienne ferme le lien sur un type inconnu). */
  accepts?: string[];
};
export type RelayReqFrame = {
  t: "req";
  id: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body: "none" | "stream";
};
export type RelayResFrame = { t: "res"; id: number; status: number; headers?: Record<string, string> };
export type RelayEndFrame = { t: "end"; id: number };
export type RelayCancelFrame = { t: "cancel"; id: number };
export type RelayErrFrame = { t: "err"; id: number; code: string; message?: string; stage: RelayErrStage };
export type RelayPingFrame = { t: "ping" };
export type RelayPongFrame = { t: "pong" };

export type RelayTextFrame =
  | RelayHelloFrame
  | RelayLinkChallengeFrame
  | RelayLinkProofFrame
  | RelayAuditKeyFrame
  | RelayAuditAnchorFrame
  | RelayCapabilitiesFrame
  | RelayInventoryChangedFrame
  | RelayDiagnosticFrame
  | RelayDiagnosticAckFrame
  | RelayLinkIssuedFrame
  | RelayLinkRotateFrame
  | RelayLinkRetireFrame
  | RelayLinkRetiredFrame
  | RelayLinkContextFrame
  | RelayReqFrame
  | RelayResFrame
  | RelayEndFrame
  | RelayCancelFrame
  | RelayErrFrame
  | RelayPingFrame
  | RelayPongFrame;

export type RelayFrameType = RelayTextFrame["t"];

export class RelayFrameError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RelayFrameError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const MAX_U32 = 0xffff_ffff;

/** Sérialise une trame de contrôle ; refuse une trame sans type ou hors borne. */
export function encodeTextFrame(frame: RelayTextFrame): string {
  const type: unknown = frame.t;
  if (typeof type !== "string" || type === "") {
    throw new RelayFrameError("frame without type");
  }
  const text = JSON.stringify(frame);
  const size = encoder.encode(text).byteLength;
  if (size > RELAY_MAX_TEXT_FRAME) {
    throw new RelayFrameError(`text frame of ${size} bytes exceeds ${RELAY_MAX_TEXT_FRAME}`);
  }
  return text;
}

/**
 * Analyse une trame de contrôle et valide les champs que son type exige,
 * mêmes règles que `DecodeText` côté Go : un `id` est un entier `uint32`
 * strictement positif, `body` vaut `none` ou `stream`, `stage` est l'une des
 * deux étapes connues, tout type inconnu est refusé.
 */
export function decodeTextFrame(raw: string | Uint8Array): RelayTextFrame {
  const size = typeof raw === "string" ? encoder.encode(raw).byteLength : raw.byteLength;
  if (size > RELAY_MAX_TEXT_FRAME) {
    throw new RelayFrameError(`text frame of ${size} bytes exceeds ${RELAY_MAX_TEXT_FRAME}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === "string" ? raw : decoder.decode(raw));
  } catch (error) {
    throw new RelayFrameError("malformed text frame", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RelayFrameError("malformed text frame: not an object");
  }
  const frame = parsed as Record<string, unknown>;
  const t = optionalString(frame, "t") ?? "";
  const id = optionalU32(frame, "id");
  switch (t) {
    case "hello": {
      const protocol = optionalInt(frame, "protocol");
      if (protocol !== RELAY_PROTOCOL) throw new RelayFrameError(`unsupported protocol ${protocol ?? 0}`);
      const devicePublicKey = optionalString(frame, "devicePublicKey");
      if (devicePublicKey !== undefined && !BASE64_32_PATTERN.test(devicePublicKey)) {
        throw new RelayFrameError("hello devicePublicKey must be a 32-byte base64 key");
      }
      return {
        t,
        protocol,
        ...withOptional("agent", optionalString(frame, "agent")),
        ...withOptional("hermesVersion", optionalString(frame, "hermesVersion")),
        ...withOptional("features", optionalFeatures(frame)),
        ...withOptional("devicePublicKey", devicePublicKey),
      };
    }
    case "link.challenge": {
      const nonce = optionalString(frame, "nonce") ?? "";
      if (!BASE64_32_PATTERN.test(nonce)) throw new RelayFrameError("link.challenge requires a 32-byte base64 nonce");
      return { t, nonce };
    }
    case "link.proof": {
      const signature = optionalString(frame, "signature") ?? "";
      if (!BASE64_64_PATTERN.test(signature)) throw new RelayFrameError("link.proof requires a 64-byte base64 signature");
      return { t, signature };
    }
    case "audit.key": {
      const runtimeId = optionalString(frame, "runtimeId");
      const keyId = optionalString(frame, "keyId") ?? "";
      const key = optionalString(frame, "key") ?? "";
      if (!runtimeId || !AUDIT_KEY_ID_PATTERN.test(keyId) || !BASE64_32_PATTERN.test(key)) {
        throw new RelayFrameError("audit.key requires runtimeId, keyId and a 32-byte base64 key");
      }
      const previous = optionalAuditKeyRefs(frame);
      return { t, runtimeId, keyId, key, ...withOptional("previous", previous) };
    }
    case "audit.anchor": {
      const runtimeId = optionalString(frame, "runtimeId");
      const keyId = optionalString(frame, "keyId") ?? "";
      const tail = optionalString(frame, "tail") ?? "";
      const writeSeq = optionalInt(frame, "writeSeq") ?? 0;
      const count = optionalInt(frame, "count") ?? 0;
      const dropped = optionalInt(frame, "dropped") ?? 0;
      if (!runtimeId || !AUDIT_KEY_ID_PATTERN.test(keyId) || !AUDIT_TAIL_PATTERN.test(tail) || writeSeq < 0 || count < 0 || dropped < 0) {
        throw new RelayFrameError("audit.anchor requires runtimeId, keyId and a hex tail");
      }
      return { t, runtimeId, keyId, writeSeq, count, dropped, tail };
    }
    case "diagnostic.ack":
      return { t, eventId: diagnosticEventId(frame) };
    case "diagnostic": {
      const eventId = diagnosticEventId(frame);
      const component = optionalString(frame, "component");
      const state = optionalString(frame, "state");
      const code = optionalString(frame, "code") ?? "";
      const occurredAt = optionalString(frame, "occurredAt") ?? "";
      const message = optionalString(frame, "message");
      const stack = optionalString(frame, "stack");
      if ((component !== "link" && component !== "operator")
        || (state !== "unavailable" && state !== "recovered")
        || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code)
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(occurredAt)
        || !Number.isFinite(Date.parse(occurredAt))
        || message === undefined || encoder.encode(message).byteLength > 256
        || (stack !== undefined && encoder.encode(stack).byteLength > 8192)) {
        throw new RelayFrameError("invalid diagnostic fields");
      }
      return { t, eventId, component, state, code, occurredAt, message, ...withOptional("stack", stack) };
    }
    case "capabilities":
      return { t, ...withOptional("features", optionalFeatures(frame)) };
    case "link.issued":
    case "link.rotate": {
      const runtimeId = optionalString(frame, "runtimeId");
      const linkToken = optionalString(frame, "linkToken");
      if (!runtimeId || !linkToken) throw new RelayFrameError(`${t} without runtimeId or linkToken`);
      return { t, runtimeId, linkToken };
    }
    case "link.retire":
    case "inventory.changed":
      return { t };
    case "link.retired": {
      const runtimeId = optionalString(frame, "runtimeId");
      if (!runtimeId) throw new RelayFrameError("link.retired without runtimeId");
      return { t, runtimeId };
    }
    case "link.context": {
      const environment = optionalString(frame, "environment");
      const ohb = optionalString(frame, "ohb");
      if ((environment !== "dev" && environment !== "preprod" && environment !== "prod") || !ohb) {
        throw new RelayFrameError("link.context requires environment dev|preprod|prod and ohb");
      }
      const organization = optionalLinkContextObject(frame, "organization", ["id", "name", "slug"]);
      const owner = optionalLinkContextObject(frame, "owner", ["email"], ["displayName"]);
      return {
        t,
        environment,
        ohb,
        ...withOptional("organization", organization as RelayLinkContextFrame["organization"]),
        ...withOptional("owner", owner as RelayLinkContextFrame["owner"]),
        ...withOptional("latestVersion", optionalString(frame, "latestVersion")),
        ...withOptional("minimumVersion", optionalString(frame, "minimumVersion")),
        ...withOptional("limits", optionalLinkContextLimits(frame)),
        ...withOptional("accepts", optionalAccepts(frame)),
      };
    }
    case "req": {
      const method = optionalString(frame, "method");
      const path = optionalString(frame, "path");
      const body = optionalString(frame, "body");
      const headers = optionalHeaders(frame);
      if (!id || !method || !path || (body !== "none" && body !== "stream")) {
        throw new RelayFrameError("req requires id, method, path and body none|stream");
      }
      return { t, id, method, path, ...withOptional("headers", headers), body };
    }
    case "res": {
      const status = optionalInt(frame, "status");
      const headers = optionalHeaders(frame);
      if (!id || !status) throw new RelayFrameError("res requires id and status");
      return { t, id, status, ...withOptional("headers", headers) };
    }
    case "end":
    case "cancel": {
      if (!id) throw new RelayFrameError(`${t} requires id`);
      return { t, id };
    }
    case "err": {
      const code = optionalString(frame, "code");
      const stage = optionalString(frame, "stage");
      if (!id || !code || (stage !== "before_dispatch" && stage !== "after_dispatch")) {
        throw new RelayFrameError("err requires id, code and a valid stage");
      }
      return { t, id, code, ...withOptional("message", optionalString(frame, "message")), stage };
    }
    case "ping":
    case "pong":
      return { t };
    default:
      throw new RelayFrameError(`unknown frame type "${t}"`);
  }
}

/** Construit un fragment de corps : `[u32 BE id][bytes]`. */
export function encodeBinaryFrame(id: number, chunk: Uint8Array): Uint8Array {
  if (!Number.isInteger(id) || id < 0 || id > MAX_U32) {
    throw new RelayFrameError(`binary frame id ${id} is not a uint32`);
  }
  const out = new Uint8Array(4 + chunk.byteLength);
  new DataView(out.buffer, out.byteOffset, 4).setUint32(0, id, false);
  out.set(chunk, 4);
  return out;
}

/** Sépare un fragment de corps en `{ id, chunk }`. */
export function decodeBinaryFrame(bytes: Uint8Array): { id: number; chunk: Uint8Array } {
  if (bytes.byteLength < 4) throw new RelayFrameError("binary frame shorter than 4 bytes");
  const id = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
  return { id, chunk: bytes.subarray(4) };
}

/** Bornes des textes de `link.context`, identiques à `MaxLinkContextText` en Go. */
const MAX_LINK_CONTEXT_TEXT = 256;

function optionalLinkContextObject(
  frame: Record<string, unknown>,
  key: string,
  required: string[],
  optional: string[] = [],
): Record<string, string> | undefined {
  const value = frame[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new RelayFrameError(`field ${key} must be an object`);
  const object = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const field of [...required, ...optional]) {
    const text = optionalString(object, field);
    if (text === undefined) {
      if (required.includes(field)) throw new RelayFrameError(`${key}.${field} is required`);
      continue;
    }
    if (text.length > MAX_LINK_CONTEXT_TEXT) throw new RelayFrameError(`${key}.${field} exceeds ${MAX_LINK_CONTEXT_TEXT} characters`);
    out[field] = text;
  }
  return out;
}

/**
 * `link.context.limits` : absent ou `null` = aucune borne annoncée ; sinon un
 * objet dont `features`, s'il est présent, est un entier d'au moins 1. Une
 * borne inconnue est ignorée, comme côté Go.
 */
function optionalLinkContextLimits(frame: Record<string, unknown>): RelayLinkContextLimits | undefined {
  const value = frame.limits;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new RelayFrameError("field limits must be an object");
  const features = optionalInt(value as Record<string, unknown>, "features");
  if (features !== undefined && features < 1) throw new RelayFrameError("limits.features must be an integer of at least 1");
  return features === undefined ? {} : { features };
}

/** Un champ absent ou `null` est traité comme non renseigné, comme en Go. */
function optionalString(frame: Record<string, unknown>, key: string): string | undefined {
  const value = frame[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new RelayFrameError(`field ${key} must be a string`);
  return value;
}

function optionalInt(frame: Record<string, unknown>, key: string): number | undefined {
  const value = frame[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new RelayFrameError(`field ${key} must be an integer`);
  }
  return value;
}

function optionalU32(frame: Record<string, unknown>, key: string): number | undefined {
  const value = optionalInt(frame, key);
  if (value === undefined) return undefined;
  if (value < 0 || value > MAX_U32) throw new RelayFrameError(`field ${key} must be a uint32`);
  return value;
}

function optionalHeaders(frame: Record<string, unknown>): Record<string, string> | undefined {
  const value = frame.headers;
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RelayFrameError("field headers must be an object");
  }
  const headers: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "string") throw new RelayFrameError(`header ${name} must be a string`);
    headers[name] = entry;
  }
  return headers;
}

/**
 * `hello.features` et `capabilities.features` : absent ou `null` = aucune
 * capacité ; sinon un tableau d'au plus `RELAY_MAX_FEATURES` identifiants
 * `^[a-z0-9_]{1,64}$`. Une valeur d'une autre forme (chaîne nue, entrée mal
 * formée) est un refus de trame, comme côté Go.
 */
function optionalFeatures(frame: Record<string, unknown>): string[] | undefined {
  const value = frame.features;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new RelayFrameError("field features must be an array");
  if (value.length > RELAY_MAX_FEATURES) {
    throw new RelayFrameError(`field features lists ${value.length} entries, more than ${RELAY_MAX_FEATURES}`);
  }
  const features: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !FEATURE_PATTERN.test(entry)) {
      throw new RelayFrameError("field features contains a malformed feature");
    }
    features.push(entry);
  }
  return features;
}

/** Au plus seize types de trame, de la grammaire des types (comme côté hôte). */
const RELAY_MAX_LINK_CONTEXT_ACCEPTS = 16;
const FRAME_TYPE_PATTERN = /^[a-z][a-z0-9_.]{0,63}$/;

function optionalAccepts(frame: Record<string, unknown>): string[] | undefined {
  const value = frame.accepts;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new RelayFrameError("field accepts must be an array");
  if (value.length > RELAY_MAX_LINK_CONTEXT_ACCEPTS) {
    throw new RelayFrameError(`field accepts lists ${value.length} entries, more than ${RELAY_MAX_LINK_CONTEXT_ACCEPTS}`);
  }
  const accepts: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !FRAME_TYPE_PATTERN.test(entry)) {
      throw new RelayFrameError("field accepts contains a malformed frame type");
    }
    accepts.push(entry);
  }
  return accepts;
}

/** `audit.key.previous` : absent, ou au plus deux `{keyId,key}` bien formés. */
function optionalAuditKeyRefs(frame: Record<string, unknown>): RelayAuditKeyRef[] | undefined {
  const value = frame.previous;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new RelayFrameError("field previous must be an array");
  if (value.length > RELAY_MAX_AUDIT_PREVIOUS_KEYS) {
    throw new RelayFrameError(`audit.key lists ${value.length} previous keys, more than ${RELAY_MAX_AUDIT_PREVIOUS_KEYS}`);
  }
  const refs: RelayAuditKeyRef[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new RelayFrameError("audit.key previous entry is invalid");
    const ref = entry as Record<string, unknown>;
    const keyId = optionalString(ref, "keyId") ?? "";
    const key = optionalString(ref, "key") ?? "";
    if (!AUDIT_KEY_ID_PATTERN.test(keyId) || !BASE64_32_PATTERN.test(key)) throw new RelayFrameError("audit.key previous entry is invalid");
    refs.push({ keyId, key });
  }
  return refs;
}

function withOptional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}

function diagnosticEventId(frame: Record<string, unknown>): string {
  const eventId = optionalString(frame, "eventId") ?? "";
  if (!isUuid(eventId)) {
    throw new RelayFrameError("diagnostic requires UUID eventId");
  }
  return eventId;
}
