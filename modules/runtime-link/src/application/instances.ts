import { isUuid } from "@openedbot/contracts-primitives";
import { RelayDialError, type RelayDialer, type RelayRequest } from "@openedbot/hermes";
import { RELAY_STAGE_HEADER, relayStageOf, type RelayLinkRotateFrame } from "@openedbot/contracts-connector";
import type { Db } from "@openedbot/platform-db";
import { LINK_PROBE_TIMEOUT_MS, parseLinkProbeResult, type LinkProbeResult } from "../domain/link-probe";

/** Préfixe du relais interne ; les routes le réexportent. */
export const RUNTIME_LINK_INTERNAL_PREFIX = "/internal/runtime-links";
/** En-tête anti-boucle : une instance qui le reçoit et devrait encore forwarder répond 508. */
export const RUNTIME_LINK_RELAY_HOP_HEADER = "X-OpenedBot-Relay-Hop";
/** Its name before the openedbot rename: an instance not yet redeployed still sets it, and a hop must stay one hop. Read for one release. */
export const LEGACY_RUNTIME_LINK_RELAY_HOP_HEADER = "X-OHB-Relay-Hop";

/** Did this request already take its one hop (under either name)? */
export function relayHopped(header: (name: string) => string | undefined): boolean {
  return Boolean(header(RUNTIME_LINK_RELAY_HOP_HEADER) || header(LEGACY_RUNTIME_LINK_RELAY_HOP_HEADER));
}
/** En-tête posé sur une réponse qui décrit une panne du LIEN, pas une réponse gateway. */
export const RUNTIME_LINK_RELAY_STAGE_HEADER = RELAY_STAGE_HEADER;

/**
 * Registre des instances API et résolution de l'instance qui tient un lien.
 *
 * Le broker reste local au processus. Cette feuille dit où vit le WebSocket
 * (`runtimes.link_instance_id` joint à `api_instances`) et comment y relayer
 * une requête interne. Une instance sans heartbeat depuis 60 s, ou marquée
 * `stopped_at`, est morte.
 */

export const API_INSTANCE_HEARTBEAT_MS = 15_000;
export const API_INSTANCE_DEAD_AFTER_MS = 60_000;
export const API_INSTANCE_DEAD_AFTER_SQL = "interval '60 seconds'";

export type LinkUnavailableDetail = "instance_dead" | "no_link";

export type LinkLocation =
  | { kind: "local" }
  | { kind: "remote"; instanceId: string; internalUrl: string }
  | { kind: "unavailable"; detail: LinkUnavailableDetail };

export type RuntimeLinkLocator = {
  instanceId: string;
  locate(runtimeId: string): Promise<LinkLocation>;
  /** Relais HTTP vers l'instance propriétaire (même chemin, même bearer, hop=1). */
  forwardProxy(runtimeId: string, request: Request): Promise<Response>;
  forwardDial(runtimeId: string, request: RelayRequest, signal?: AbortSignal): Promise<Response>;
  forwardRotate(runtimeId: string, frame: RelayLinkRotateFrame): Promise<boolean>;
  forwardClose(runtimeId: string, code: number, reason: string): Promise<boolean>;
  /** Sonde le lien sur l'instance propriétaire ; attend son verdict, borné. */
  forwardProbe(runtimeId: string, expectedGeneration: string | null): Promise<LinkProbeResult>;
};

export type InstanceRegistry = {
  heartbeat(): Promise<void>;
  stop(): Promise<void>;
};

export const NO_RUNTIME_LINK_LOCATOR: RuntimeLinkLocator = {
  instanceId: "",
  locate: async () => ({ kind: "unavailable", detail: "no_link" }),
  forwardProxy: async () => unavailableResponse("no_link"),
  forwardDial: async () => {
    throw unavailableDial("no_link");
  },
  forwardRotate: async () => false,
  forwardClose: async () => false,
  forwardProbe: async () => ({ outcome: "no_link" }),
};

let installedLocator: RuntimeLinkLocator = NO_RUNTIME_LINK_LOCATOR;

export function installRuntimeLinkLocator(locator: RuntimeLinkLocator): void {
  installedLocator = locator;
}

export function runtimeLinkLocator(): RuntimeLinkLocator {
  return installedLocator;
}

export type LocatorConfig = {
  instanceId: string;
  apiInternalUrl: string;
  workerInternalToken: string;
};

type OwnerRow = {
  instanceId: string | null;
  internalUrl: string | null;
  instanceLive: boolean | null;
};

/**
 * Où vit le lien d'un runtime. Court-circuit local si `link_instance_id`
 * désigne CETTE instance ; URL interne si l'instance propriétaire est vivante ;
 * `instance_dead` / `no_link` sinon, jamais un faux `disconnected`.
 */
export async function resolveLinkLocation(
  db: Db,
  runtimeId: string,
  currentInstanceId: string,
): Promise<LinkLocation> {
  if (!isUuid(runtimeId)) return { kind: "unavailable", detail: "no_link" };
  let rows: OwnerRow[];
  try {
    rows = await db<OwnerRow[]>`
      select instance_id as "instanceId",
             internal_url as "internalUrl",
             instance_live as "instanceLive"
        from runtime_link_owner(${runtimeId}::uuid)
    `;
  } catch {
    return { kind: "unavailable", detail: "no_link" };
  }
  const row = rows[0];
  if (!row || !row.instanceId) return { kind: "unavailable", detail: "no_link" };
  if (row.instanceId === currentInstanceId) return { kind: "local" };
  if (!row.instanceLive || !row.internalUrl) return { kind: "unavailable", detail: "instance_dead" };
  return { kind: "remote", instanceId: row.instanceId, internalUrl: row.internalUrl };
}

/**
 * URL interne de l'instance qui tient le lien. Court-circuit : l'URL de
 * CETTE instance si le lien est local. `null` + `detail` si mort ou absent.
 */
export async function resolveInstanceUrl(
  db: Db,
  runtimeId: string,
  current: Pick<LocatorConfig, "instanceId" | "apiInternalUrl">,
): Promise<{ url: string; local: true } | { url: string; local: false } | { url: null; detail: LinkUnavailableDetail }> {
  const location = await resolveLinkLocation(db, runtimeId, current.instanceId);
  if (location.kind === "local") return { url: current.apiInternalUrl, local: true };
  if (location.kind === "remote") return { url: location.internalUrl, local: false };
  return { url: null, detail: location.detail };
}

export function createApiInstanceRegistry(
  db: Db,
  config: LocatorConfig,
  startedAt: Date = new Date(),
): InstanceRegistry {
  return {
    async heartbeat() {
      await db`
        insert into api_instances (instance_id, internal_url, started_at, last_seen_at, stopped_at)
        values (${config.instanceId}, ${config.apiInternalUrl}, ${startedAt}, now(), null)
        on conflict (instance_id) do update
          set internal_url = excluded.internal_url,
              last_seen_at = now(),
              stopped_at = null
      `;
    },
    async stop() {
      await db`
        update api_instances
           set stopped_at = now(), last_seen_at = now()
         where instance_id = ${config.instanceId}
      `;
    },
  };
}

export function createRuntimeLinkLocator(
  db: Db,
  config: LocatorConfig,
  fetchImpl: typeof fetch = fetch,
): RuntimeLinkLocator {
  const locate = (runtimeId: string) => resolveLinkLocation(db, runtimeId, config.instanceId);

  async function remoteUrl(runtimeId: string): Promise<{ url: string } | { detail: LinkUnavailableDetail }> {
    const location = await locate(runtimeId);
    if (location.kind === "remote") return { url: location.internalUrl };
    return { detail: location.kind === "unavailable" ? location.detail : "no_link" };
  }

  return {
    instanceId: config.instanceId,
    locate,
    async forwardProxy(runtimeId, request) {
      const target = await remoteUrl(runtimeId);
      if (!("url" in target)) return unavailableResponse(target.detail);
      return hopFetch(fetchImpl, proxyUrl(target.url, runtimeId, proxyPathOf(request, runtimeId)), request);
    },
    async forwardDial(runtimeId, request, signal) {
      const target = await remoteUrl(runtimeId);
      if (!("url" in target)) throw unavailableDial(target.detail);
      const headers = new Headers(request.headers);
      headers.set("Authorization", `Bearer ${config.workerInternalToken}`);
      let response: Response;
      try {
        response = await fetchImpl(proxyUrl(target.url, runtimeId, request.path), {
          method: request.method,
          headers,
          body: request.body,
          signal,
          cache: "no-store",
          redirect: "manual",
          ...(request.body instanceof ReadableStream ? { duplex: "half" as const } : {}),
        } as RequestInit);
      } catch (error) {
        throw forwardingFailure(error);
      }
      const stage = relayStageOf(response.headers);
      if (stage === "before_dispatch" || stage === "after_dispatch") {
        throw await dialFailureFromRelay(response, stage);
      }
      return response;
    },
    async forwardRotate(runtimeId, frame) {
      const target = await remoteUrl(runtimeId);
      if (!("url" in target)) return false;
      return forwardControl(fetchImpl, config, target.url, runtimeId, {
        kind: "rotate",
        runtimeId: frame.runtimeId,
        linkToken: frame.linkToken,
      });
    },
    async forwardClose(runtimeId, code, reason) {
      const target = await remoteUrl(runtimeId);
      if (!("url" in target)) return false;
      return forwardControl(fetchImpl, config, target.url, runtimeId, {
        kind: "close",
        code,
        reason,
      });
    },
    async forwardProbe(runtimeId, expectedGeneration) {
      const target = await remoteUrl(runtimeId);
      if (!("url" in target)) return { outcome: target.detail === "instance_dead" ? "owner_unavailable" : "no_link" };
      try {
        const response = await fetchImpl(
          `${target.url.replace(/\/+$/, "")}${RUNTIME_LINK_INTERNAL_PREFIX}/${encodeURIComponent(runtimeId)}/probe`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.workerInternalToken}`,
              "Content-Type": "application/json",
              [RUNTIME_LINK_RELAY_HOP_HEADER]: "1",
            },
            body: JSON.stringify({ generation: expectedGeneration }),
            cache: "no-store",
            redirect: "manual",
            // La fenêtre du pong, plus la marge du saut : jamais une attente sans fin.
            signal: AbortSignal.timeout(LINK_PROBE_TIMEOUT_MS + 5_000),
          },
        );
        if (!response.ok) return { outcome: "owner_unavailable" };
        return parseLinkProbeResult(await response.json().catch(() => null));
      } catch {
        return { outcome: "owner_unavailable" };
      }
    },
  };
}

export function instanceAwareDial(
  localDial: () => RelayDialer,
  isConnected: () => boolean,
  locator: RuntimeLinkLocator,
  runtimeId: string,
): RelayDialer {
  return async (request, signal) => {
    if (isConnected()) return localDial()(request, signal);
    // Localiser le lien est une lecture en base AVANT tout envoi : si elle
    // échoue, rien n'est parti, et l'erreur doit le dire (`before_dispatch`)
    // plutôt que de passer pour un lien interrompu après envoi. Le transport
    // le conclut d'une erreur sans étape, et une route le prendrait pour une
    // observation du runtime.
    let location: LinkLocation;
    try {
      location = await locator.locate(runtimeId);
    } catch (cause) {
      throw new RelayDialError(
        "Le lien connecteur n’a pas pu être localisé.",
        "before_dispatch",
        "RUNTIME_LINK_LOCATE_FAILED",
        { cause },
      );
    }
    if (location.kind === "remote") return locator.forwardDial(runtimeId, request, signal);
    throw unavailableDial(location.kind === "unavailable" ? location.detail : "no_link");
  };
}

export function unavailableDial(detail: LinkUnavailableDetail, cause?: unknown): RelayDialError {
  return new RelayDialError(unavailableMessage(detail), "before_dispatch", "RUNTIME_LINK_UNAVAILABLE", cause ? { cause } : undefined);
}

export function unavailableMessage(detail: LinkUnavailableDetail): string {
  return detail === "instance_dead"
    ? "L’instance qui tenait le lien connecteur ne répond plus."
    : "Ce runtime n’a pas de lien connecteur ouvert.";
}

export function unavailableResponse(detail: LinkUnavailableDetail, status = 503): Response {
  return Response.json(
    { error: { code: "RUNTIME_LINK_UNAVAILABLE", message: unavailableMessage(detail), stage: "before_dispatch", detail } },
    { status, headers: { [RUNTIME_LINK_RELAY_STAGE_HEADER]: "before_dispatch", "Cache-Control": "no-store" } },
  );
}

export function loopResponse(): Response {
  return Response.json(
    { error: { code: "RUNTIME_LINK_LOOP", message: "Le relais du lien connecteur a détecté une boucle.", stage: "before_dispatch" } },
    { status: 508, headers: { [RUNTIME_LINK_RELAY_STAGE_HEADER]: "before_dispatch", "Cache-Control": "no-store" } },
  );
}

function proxyUrl(internalUrl: string, runtimeId: string, path: string): string {
  return `${internalUrl.replace(/\/+$/, "")}${RUNTIME_LINK_INTERNAL_PREFIX}/${encodeURIComponent(runtimeId)}/proxy${path}`;
}

function proxyPathOf(request: Request, runtimeId: string): string {
  const url = new URL(request.url);
  const prefix = `${RUNTIME_LINK_INTERNAL_PREFIX}/${runtimeId}/proxy`;
  if (!url.pathname.startsWith(prefix)) return "/";
  return `${url.pathname.slice(prefix.length)}${url.search}`;
}

async function hopFetch(fetchImpl: typeof fetch, target: string, request: Request): Promise<Response> {
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower === "host" || lower === "connection" || lower === RUNTIME_LINK_RELAY_HOP_HEADER.toLowerCase() || lower === LEGACY_RUNTIME_LINK_RELAY_HOP_HEADER.toLowerCase()) return;
    headers.set(name, value);
  });
  headers.set(RUNTIME_LINK_RELAY_HOP_HEADER, "1");
  const method = request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? null : request.body;
  try {
    return await fetchImpl(target, {
      method,
      headers,
      body,
      signal: request.signal,
      cache: "no-store",
      redirect: "manual",
      ...(body instanceof ReadableStream ? { duplex: "half" as const } : {}),
    } as RequestInit);
  } catch (error) {
    const failure = forwardingFailure(error);
    if (failure.stage === "before_dispatch") return unavailableResponse("instance_dead");
    return Response.json(
      { error: { code: failure.code, message: failure.message, stage: failure.stage } },
      { status: 502, headers: { [RUNTIME_LINK_RELAY_STAGE_HEADER]: failure.stage, "Cache-Control": "no-store" } },
    );
  }
}

/** Only transport error codes proving no connection justify retrying a mutation. */
function forwardingFailure(error: unknown): RelayDialError {
  let cause: unknown = error;
  for (let depth = 0; depth < 4 && cause && typeof cause === "object"; depth++) {
    const current = cause as { code?: unknown; cause?: unknown };
    if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ConnectionRefused"].includes(String(current.code))) {
      return unavailableDial("instance_dead", error);
    }
    cause = current.cause;
  }
  return new RelayDialError(
    "La réponse du relais inter-instance est incertaine après un possible envoi.",
    "after_dispatch",
    "RUNTIME_LINK_FORWARD_OUTCOME_UNKNOWN",
    { cause: error },
  );
}

/**
 * Borne du saut qui pousse une trame de contrôle (`link.rotate`, fermeture) à
 * l'instance qui tient le lien. Le propriétaire écrit UNE trame et n'attend
 * rien de l'hôte : il ne reste que la marge du saut, celle que `forwardProbe`
 * ajoute à la fenêtre du pong. Un propriétaire vivant au bail mais muet ne
 * doit jamais suspendre la requête qui révoque ou fait tourner un jeton ; à
 * l'échéance le lien n'est pas poussé (`false`), comme sur une erreur réseau.
 */
export const LINK_CONTROL_FORWARD_TIMEOUT_MS = 5_000;

async function forwardControl(
  fetchImpl: typeof fetch,
  config: LocatorConfig,
  base: string,
  runtimeId: string,
  body: Record<string, unknown>,
): Promise<boolean> {
  try {
    const response = await fetchImpl(
      `${base.replace(/\/+$/, "")}${RUNTIME_LINK_INTERNAL_PREFIX}/${encodeURIComponent(runtimeId)}/control`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.workerInternalToken}`,
          "Content-Type": "application/json",
          [RUNTIME_LINK_RELAY_HOP_HEADER]: "1",
        },
        body: JSON.stringify(body),
        cache: "no-store",
        redirect: "manual",
        // Jamais une attente sans fin : l'échéance tombe dans le `catch` ci-dessous.
        signal: AbortSignal.timeout(LINK_CONTROL_FORWARD_TIMEOUT_MS),
      },
    );
    if (!response.ok) return false;
    const payload = await response.json().catch(() => null) as { pushed?: unknown } | null;
    return payload?.pushed === true;
  } catch {
    return false;
  }
}

async function dialFailureFromRelay(response: Response, stage: "before_dispatch" | "after_dispatch"): Promise<RelayDialError> {
  let code: string | null = "RUNTIME_LINK_UNAVAILABLE";
  let message = unavailableMessage("no_link");
  try {
    const body = await response.json() as { error?: { code?: unknown; message?: unknown; detail?: unknown } };
    if (typeof body.error?.code === "string") code = body.error.code;
    if (typeof body.error?.message === "string") message = body.error.message;
    if (body.error?.detail === "instance_dead" || body.error?.detail === "no_link") {
      return new RelayDialError(message, stage, code);
    }
  } catch {
    // Corps illisible : le statut et l'étape suffisent.
  }
  return new RelayDialError(message, stage, code);
}
