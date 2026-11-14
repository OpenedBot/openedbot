import { hermesCapabilityWrite, hermesToolsetInventoryWrite, RelayDialError, type RelayDialer } from "@openedbot/hermes";
import {
  RELAY_CLOSE_RECONNECT,
  RELAY_CLOSE_REPLACED,
  RELAY_CLOSE_REVOKED,
  RELAY_CLOSE_UNAUTHORIZED,
  RELAY_FIRST_RESPONSE_LIMIT_S,
  type RelayErrStage,
  type RelayTextFrame,
} from "@openedbot/contracts-connector";
import { logEvent } from "@openedbot/platform-observability";
import { sanitizeDiagnosticText } from "../domain/diagnostics";
import {
  LINK_PROBE_TIMEOUT_MS,
  LINK_RECONNECT_REASON,
  type LinkProbeResult,
} from "@openedbot/runtimes/domain/link-probe";
import {
  describeLinkClosure,
  LinkLeaseLostError,
  type LinkSocket,
  type LinkIdentity,
  type LinkPeer,
  type LinkEventKind,
  type LinkEventMeta,
  type RuntimeLinkBrokerOptions,
  type ConnectionOptions,
} from "./link-types";
import { LinkConnection } from "./link-connection";
import { pgTextArray } from "@openedbot/platform-db/text-array";

/**
 * Le broker du lien connecteur, côté openedbot de `docs/CONNECTOR.md`.
 *
 * Un hôte ouvre UNE connexion WebSocket sortante ; les requêtes gateway que
 * l'API et le worker veulent lui adresser sont multiplexées dessus, chacune
 * sous un identifiant `uint32` alloué ici. Le broker ne connaît ni URL ni
 * bearer : il relaie les trames du contrat, rien d'autre, et n'émet jamais
 * un verbe exec/update/restart: l'allowlist est vérifiée avant chaque `req`.
 *
 * Registre en mémoire, une connexion par runtime : la plus récente gagne,
 * l'ancienne est fermée 4001 et ses requêtes en vol échouent `after_dispatch`.
 * Le transfert vers une autre instance passe par le relais HTTP
 * instance-aware (`instances.ts`) : ce broker ne voit que les sockets d'ICI.
 */

export { LinkConnection };
export { createLinkLivenessStore, insertRuntimeLinkEvent } from "./link-persistence";
export type { LinkLivenessStoreOptions } from "./link-persistence";
export { describeLinkClosure, LinkLeaseLostError } from "./link-types";
export type {
  LinkDispatchRecord,
  LinkEventKind,
  LinkEventMeta,
  LinkIdentity,
  LinkLivenessStore,
  LinkLogger,
  LinkPeer,
  LinkSocket,
  RuntimeLinkBrokerOptions,
} from "./link-types";
/** Le littéral `text[]` vit dans `@openedbot/platform-db/text-array` ; réexporté pour les appelants du broker. */
export { pgTextArray };

const DEFAULT_EVENTS_IDLE_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_PING_INTERVAL_MS = 15_000;
const DEFAULT_SEEN_DEBOUNCE_MS = 10_000;
/**
 * Règle de détournement : un remplacement depuis une autre adresse, ou trois
 * remplacements en dix minutes pour le même runtime, vaut `hijack_suspected`.
 * Deux hôtes qui se disputent le même jeton se remplacent en boucle : c'est
 * exactement ce que cette fenêtre attrape.
 */
const HIJACK_REPLACEMENT_WINDOW_MS = 10 * 60_000;
const HIJACK_REPLACEMENT_THRESHOLD = 3;

type CapabilityWriteState = {
  connection: LinkConnection;
  initial: boolean;
  dirty: boolean;
  running: boolean;
};

export class RuntimeLinkBroker {
  private readonly registry = new Map<string, LinkConnection>();
  private readonly released = new WeakSet<LinkConnection>();
  private readonly capabilityWrites = new Map<string, CapabilityWriteState>();
  private readonly enrollmentsInProgress = new Set<string>();
  /** Instants des remplacements récents par runtime (fenêtre glissante de la règle hijack). */
  private readonly replacements = new Map<string, number[]>();
  /** Instant de la dernière liaison par runtime : deux liaisons valides d'adresses différentes en dix minutes valent une rotation d'urgence. */
  private readonly boundAt = new Map<string, number>();
  private readonly probes = new Map<LinkConnection, Promise<LinkProbeResult>>();
  private readonly options: ConnectionOptions;
  private readonly onDispatch: RuntimeLinkBrokerOptions["onDispatch"];
  private readonly pendingPersistence = new Set<Promise<unknown>>();
  private persistenceFailures = 0;
  private closing = false;

  constructor(options: RuntimeLinkBrokerOptions) {
    this.options = {
      instanceId: options.instanceId,
      liveness: new Proxy(options.liveness, {
        get: (target, property, receiver) => {
          const value = Reflect.get(target, property, receiver);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            try { return this.trackPersistence(Promise.resolve(Reflect.apply(value, target, args))); }
            catch (error) { return this.trackPersistence(Promise.reject(error)); }
          };
        },
      }),
      now: options.now ?? (() => Date.now()),
      firstResponseTimeoutMs: options.firstResponseTimeoutMs ?? RELAY_FIRST_RESPONSE_LIMIT_S * 1_000,
      eventsIdleTimeoutMs: options.eventsIdleTimeoutMs ?? DEFAULT_EVENTS_IDLE_TIMEOUT_MS,
      pingIntervalMs: options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS,
      seenDebounceMs: options.seenDebounceMs ?? DEFAULT_SEEN_DEBOUNCE_MS,
      log: options.log ?? logEvent,
      ...(options.onInventoryChanged ? { onInventoryChanged: options.onInventoryChanged } : {}),
    };
    this.onDispatch = options.onDispatch;
  }

  private trackPersistence<T>(promise: Promise<T>): Promise<T> {
    this.pendingPersistence.add(promise);
    void promise.then(() => { this.pendingPersistence.delete(promise); }, (error) => {
      this.pendingPersistence.delete(promise);
      if (this.closing && !(error instanceof LinkLeaseLostError)) this.persistenceFailures++;
    });
    return promise;
  }

  /** Call after closing sockets; the caller supplies its bounded shutdown deadline. */
  async flushPersistence(): Promise<void> {
    while (this.pendingPersistence.size) await Promise.allSettled(this.pendingPersistence);
    if (this.persistenceFailures) throw new Error(`Runtime link persistence failed (${this.persistenceFailures} writes)`);
  }

  get inFlightCount(): number {
    let count = 0;
    for (const connection of this.registry.values()) count += connection.inFlightCount;
    return count;
  }

  get instanceId(): string {
    return this.options.instanceId;
  }

  /** Une connexion qui a dit `hello`, pas encore au registre (provisoire ou en cours de liaison). */
  open(socket: LinkSocket): LinkConnection {
    return new LinkConnection(socket, this.options, (connection, features) => {
      const identity = connection.link;
      if (!identity || connection.isClosed || this.registry.get(identity.runtimeId) !== connection) return;
      connection.features = [...features];
      this.queueCapabilityWrite(connection, false);
    }, (connection) => {
      const state = connection.link ? this.capabilityWrites.get(connection.link.runtimeId) : undefined;
      if (state?.connection === connection && state.dirty) void this.flushCapabilityWrite(connection.link!.runtimeId, state);
    }, (connection, code, reason) => this.release(connection, code, reason));
  }

  /**
   * Entre la connexion au registre sous son runtime. La précédente, s'il y en
   * a une, est fermée 4001 : ses requêtes en vol échouent `after_dispatch`.
   *
   * Journal : `connected`, ou `replaced` avec l'adresse précédente, et
   * `hijack_suspected` si l'adresse a changé ou si les remplacements
   * s'enchaînent (fenêtre glissante en mémoire, par runtime).
   */
  bind(connection: LinkConnection, identity: LinkIdentity, peer?: LinkPeer): Promise<void> {
    const previous = this.registry.get(identity.runtimeId);
    const replaced = previous !== undefined && previous !== connection;
    const previousIp = replaced ? previous.peer.ip : null;
    if (replaced) {
      this.registry.delete(identity.runtimeId);
      previous.close(RELAY_CLOSE_REPLACED, "LINK_REPLACED");
      this.release(previous, RELAY_CLOSE_REPLACED, "LINK_REPLACED");
    }
    connection.bind(identity, peer);
    this.registry.set(identity.runtimeId, connection);
    const previousBoundAt = this.boundAt.get(identity.runtimeId);
    this.boundAt.set(identity.runtimeId, this.options.now());
    this.queueCapabilityWrite(connection, true);
    const publish = () => {
      if (connection.isClosed || this.registry.get(identity.runtimeId) !== connection) return;
      const ip = connection.peer.ip;
      const agent = connection.agent ?? connection.peer.agent;
      this.options.log("runtime_link.connected", {
        runtimeId: identity.runtimeId,
        instanceId: this.options.instanceId, generation: connection.link?.generation ?? null,
        ip,
        agent: connection.agent,
        features: connection.features,
        ...(replaced ? { replaced: true, previousIp } : {}),
      });
      if (!replaced) {
        this.emit(connection.link!, "connected", { ip, agent });
        return;
      }
      this.emit(connection.link!, "replaced", { ip, agent, previousIp });
      // Le remplacement est TOUJOURS compté dans la fenêtre, même quand
      // l'adresse suffit à le rendre suspect : un A→B puis deux B→B font trois.
      const burst = this.replacementBurst(identity.runtimeId);
      if (previousIp !== ip || burst) {
        this.options.log("runtime_link.hijack_suspected", { runtimeId: identity.runtimeId, ip, previousIp });
        this.emit(connection.link!, "hijack_suspected", { ip, agent, previousIp });
      }
      // Deux sockets VALIDES (jeton et, s'il existe, preuve de possession)
      // depuis deux adresses en moins de dix minutes : la machine a été
      // dupliquée ou sa clé copiée. Le jeton meurt tout de suite, sans grâce
      // et sans remise à qui que ce soit, et la connexion gagnante aussi.
      const rotate = this.options.liveness.emergencyRotate;
      if (rotate && previousIp !== null && previousIp !== ip && previousBoundAt !== undefined
        && this.options.now() - previousBoundAt < HIJACK_REPLACEMENT_WINDOW_MS) {
        this.options.log("runtime_link.emergency_rotation", { runtimeId: identity.runtimeId, ip, previousIp });
        void rotate.call(this.options.liveness, connection.link!, { ip, agent, previousIp, automatic: true, reason: "hijack_suspected", instanceId: this.options.instanceId, generation: identity.generation ?? null })
          .then(() => connection.close(RELAY_CLOSE_UNAUTHORIZED, "LINK_ROTATED"))
          .catch((error) => {
            this.options.log("runtime_link.liveness_failed", { runtimeId: identity.runtimeId, write: "emergency_rotate", error: String(error) });
          });
      }
    };
    if (connection.isAdmitted) publish();
    else void connection.whenAdmitted().then(publish).catch(() => {});
    return connection.whenAdmitted();
  }

  /** One in-flight write and one latest inventory per runtime, even during a flood. */
  private queueCapabilityWrite(connection: LinkConnection, initial: boolean): void {
    const runtimeId = connection.link!.runtimeId;
    let state = this.capabilityWrites.get(runtimeId);
    if (!state) {
      state = { connection, initial, dirty: true, running: false };
      this.capabilityWrites.set(runtimeId, state);
    } else {
      if (state.connection !== connection) state.initial = initial;
      else state.initial ||= initial;
      state.connection = connection;
      state.dirty = true;
    }
    void this.flushCapabilityWrite(runtimeId, state);
  }

  private async flushCapabilityWrite(runtimeId: string, state: CapabilityWriteState): Promise<void> {
    if (state.running) return;
    state.running = true;
    try {
      while (state.dirty) {
        const connection = state.connection;
        if (connection.isClosed || this.registry.get(runtimeId) !== connection) {
          state.dirty = false;
          break;
        }
        const initial = state.initial;
        const features = [...connection.features];
        state.dirty = false;
        try {
          if (initial) {
            const claim = (async () => {
              if (this.options.liveness.reserveGeneration) await connection.reserveGeneration();
              if (connection.isClosed || this.registry.get(runtimeId) !== connection) return;
              await this.options.liveness.connected(connection.link!, this.options.instanceId, features);
              connection.admit();
            })();
            connection.claimInFlight = claim;
            try { await claim; } finally { connection.claimInFlight = null; }
          } else await this.options.liveness.capabilities?.(connection.link!, this.options.instanceId, features);
          if (state.connection === connection) state.initial = false;
        } catch (error) {
          this.options.log("runtime_link.liveness_failed", {
            runtimeId, instanceId: this.options.instanceId, generation: connection.link?.generation ?? null, write: initial ? "connected" : "capabilities", error: String(error),
          });
          if (error instanceof LinkLeaseLostError) connection.close(1012, "LINK_LEASE_LOST");
          if (state.connection === connection) {
            // Keep only the latest inventory; a successful heartbeat retries it.
            state.dirty = true;
            break;
          }
        }
      }
    } finally {
      state.running = false;
      if ((!state.dirty || state.connection.isClosed) && this.capabilityWrites.get(runtimeId) === state) {
        this.capabilityWrites.delete(runtimeId);
      }
    }
  }

  /** Compte ce remplacement et dit si le runtime en a subi ≥ 3 en dix minutes. */
  private replacementBurst(runtimeId: string): boolean {
    const now = this.options.now();
    const recent = (this.replacements.get(runtimeId) ?? []).filter((at) => now - at < HIJACK_REPLACEMENT_WINDOW_MS);
    recent.push(now);
    this.replacements.set(runtimeId, recent);
    return recent.length >= HIJACK_REPLACEMENT_THRESHOLD;
  }

  /** Un événement du lien écrit par la passerelle (preuve de possession) plutôt que par le broker lui-même. */
  journal(identity: LinkIdentity, kind: LinkEventKind, meta: LinkEventMeta): void {
    this.emit(identity, kind, meta);
  }

  private emit(identity: LinkIdentity, kind: LinkEventKind, meta: LinkEventMeta): void {
    const event = this.options.liveness.event;
    if (!event) return;
    void event.call(this.options.liveness, identity, kind, { ...meta, instanceId: this.options.instanceId, generation: identity.generation ?? null }).catch((error) => {
      this.options.log("runtime_link.liveness_failed", { runtimeId: identity.runtimeId, write: `event:${kind}`, error: String(error) });
    });
  }

  /** Pousse `link.rotate` sur le lien ouvert ICI, s'il y en a un. */
  notifyRotation(runtimeId: string, frame: RelayTextFrame): boolean {
    const connection = this.connection(runtimeId);
    if (!connection) return false;
    return connection.sendFrame(frame);
  }

  /**
   * La socket s'est fermée. Seule la connexion encore au registre écrit
   * `disconnected` : une connexion remplacée ne doit pas écraser la vitalité
   * de celle qui l'a remplacée.
   */
  release(connection: LinkConnection, code: number, reason: string): void {
    if (this.released.has(connection)) return;
    this.released.add(connection);
    connection.onSocketClosed(code, reason);
    const identity = connection.link;
    if (!identity) return;
    const current = this.registry.get(identity.runtimeId) === connection;
    if (current) {
      this.registry.delete(identity.runtimeId);
      if (!this.capabilityWrites.get(identity.runtimeId)?.running) this.capabilityWrites.delete(identity.runtimeId);
      this.replacements.delete(identity.runtimeId);
    }
    // `boundAt` reste : c'est justement la fermeture-remplacement rapide qu'il mesure.
    const persist = async () => {
      if (connection.claimInFlight) await connection.claimInFlight.catch(() => {});
      const lease = connection.link!;
      // Historical test stores have no leases; production closes are recorded
      // even after replacement, with their own generation rather than the winner.
      if (!current && !lease.generation) return;
      let ownershipCurrent: boolean | null = current;
      const closeReason = sanitizeDiagnosticText(reason, 123);
      const enrollmentBye = connection.expectEnrollmentBye && code === 1000;
      if (enrollmentBye) {
        ownershipCurrent = false;
      } else if (!this.options.liveness.reserveGeneration || lease.generation) {
        try {
          await this.options.liveness.disconnected(lease, this.options.instanceId, describeLinkClosure(code, closeReason));
          ownershipCurrent = true;
        }
        catch (error) {
          ownershipCurrent = error instanceof LinkLeaseLostError ? false : null;
          if (!(error instanceof LinkLeaseLostError)) this.options.log("runtime_link.liveness_failed", {
            runtimeId: identity.runtimeId, instanceId: this.options.instanceId, generation: lease.generation ?? null, write: "disconnected", error: String(error),
          });
        }
      } else ownershipCurrent = false;
      this.options.log("runtime_link.disconnected", { runtimeId: identity.runtimeId, instanceId: this.options.instanceId, generation: lease.generation ?? null, code, reason: closeReason, ownershipCurrent });
      this.emit(lease, "disconnected", { ip: connection.peer.ip, agent: connection.agent ?? connection.peer.agent, closeCode: code, closeReason, ownershipCurrent });
    };
    void this.trackPersistence(persist());
  }

  connected(runtimeId: string): boolean {
    const connection = this.registry.get(runtimeId);
    return connection !== undefined && !connection.isClosed && connection.isAdmitted;
  }

  connection(runtimeId: string): LinkConnection | null {
    const connection = this.registry.get(runtimeId);
    return connection && !connection.isClosed && connection.isAdmitted ? connection : null;
  }

  /** Le `RelayDialer` d'un runtime tenu par CETTE instance ; sinon refus `before_dispatch`. */
  dialer(runtimeId: string): RelayDialer {
    return (request, signal) => {
      const connection = this.connection(runtimeId);
      if (!connection) {
        return Promise.reject(
          new RelayDialError("Le runtime n'a pas de lien connecteur ouvert sur cette instance.", "before_dispatch", "RUNTIME_LINK_UNAVAILABLE"),
        );
      }
      const startedAt = performance.now();
      const dispatched = connection.dispatch(request, signal);
      const onDispatch = this.onDispatch;
      if (onDispatch) {
        const report = (status: number | null) => {
          try {
            onDispatch({ runtimeId, method: request.method, path: request.path, status, durationMs: Math.round(performance.now() - startedAt) });
          } catch { /* a metrics hook never breaks a host call */ }
        };
        // A refusal before anything was sent (aborted signal, in-flight
        // bound, forbidden path) never reached the host: not a host call.
        dispatched.then((response) => report(response.status), (error: unknown) => {
          if (!(error instanceof RelayDialError && error.stage === "before_dispatch")) report(null);
        });
      }
      const link = connection.link;
      if (!link) return dispatched;
      const toolsets = hermesToolsetInventoryWrite(request.method, request.path);
      const capability = hermesCapabilityWrite(request.method, request.path);
      if (!toolsets && !capability) return dispatched;
      // Every path to the host (API routes, the worker's relay, a forwarded
      // hop) ends here, so this is the one place that sees each inventory
      // write. Bumped AFTER the host answered: a worker that reads the new
      // epoch then reads the inventory live sees the write applied, and a
      // message sent once the switch has flipped finds the capability mark
      // (0163) already there. A write the host refused (4xx) or that never
      // left (`before_dispatch`) changed nothing: marking it would move every
      // thread of the runtime to a new session for nothing. Any other
      // outcome (2xx, 5xx, a lost answer) may have written, and is marked.
      const note = async () => {
        if (toolsets) await this.noteToolsetWrite(link);
        if (capability) await this.noteCapabilityWrite(link, capability.profile);
      };
      return dispatched.then(async (response) => {
        if (response.status < 400 || response.status >= 500) await note();
        return response;
      }, async (error: unknown) => {
        if (!(error instanceof RelayDialError && error.stage === "before_dispatch")) await note();
        throw error;
      });
    };
  }

  private async noteCapabilityWrite(link: LinkIdentity, profile: string | null): Promise<void> {
    try {
      await this.options.liveness.capabilitiesWritten?.(link, profile);
    } catch (error) {
      // A missed mark leaves open threads on their frozen tools until the next change.
      this.options.log("runtime_link.capabilities_mark_failed", { runtimeId: link.runtimeId, profile, error: String(error) });
    }
  }

  private async noteToolsetWrite(link: LinkIdentity): Promise<void> {
    try {
      await this.options.liveness.toolsetsWritten?.(link);
    } catch (error) {
      // A missed bump leaves the worker's entry valid until its TTL (60 s).
      this.options.log("runtime_link.toolset_epoch_failed", { runtimeId: link.runtimeId, error: String(error) });
    }
  }

  /** Ferme le lien ouvert ICI avec le code donné (rotation d'urgence : 4401 `LINK_ROTATED`). */
  closeLink(runtimeId: string, code: number, reason: string): boolean {
    const connection = this.registry.get(runtimeId);
    if (!connection) return false;
    connection.close(code, reason);
    this.release(connection, code, reason);
    return true;
  }

  /**
   * Ferme CETTE connexion si elle tient encore le lien de son runtime. Une
   * décision prise sur une connexion lue plus tôt ne ferme jamais celle qui
   * l'a remplacée entre-temps.
   */
  closeIfCurrent(connection: LinkConnection, code: number, reason: string): boolean {
    const identity = connection.link;
    if (!identity || connection.isClosed || this.registry.get(identity.runtimeId) !== connection) return false;
    connection.close(code, reason);
    this.release(connection, code, reason);
    return true;
  }

  /**
   * « Vérifier le lien » : ping natif sur la connexion tenue ICI. Pong ou
   * trame reçue : vivant. Rien : la connexion sondée est raccrochée 4005, si
   * elle tient encore le lien, et l'hôte se reconnecte. Les demandes
   * simultanées sur la même connexion partagent la même sonde.
   *
   * `expectedGeneration` : le bail lu en base par l'appelant. Si une autre
   * connexion le tient déjà, rien n'est sondé ni fermé.
   */
  probeLink(runtimeId: string, expectedGeneration: string | null, timeoutMs = LINK_PROBE_TIMEOUT_MS): Promise<LinkProbeResult> {
    const connection = this.connection(runtimeId);
    if (!connection) return Promise.resolve({ outcome: "no_link" });
    const generation = connection.link?.generation ?? null;
    if (expectedGeneration !== null && generation !== null && generation !== expectedGeneration) {
      return Promise.resolve({ outcome: "generation_changed", generation });
    }
    const running = this.probes.get(connection);
    if (running) return running;
    const probe = this.runProbe(runtimeId, connection, generation, timeoutMs).finally(() => this.probes.delete(connection));
    this.probes.set(connection, probe);
    return probe;
  }

  private async runProbe(runtimeId: string, connection: LinkConnection, generation: string | null, timeoutMs: number): Promise<LinkProbeResult> {
    const result = await connection.probe(timeoutMs);
    if (result.alive) return { outcome: "alive", generation, rttMs: result.rttMs };
    if (result.reason === "indeterminate") return { outcome: "indeterminate", generation };
    if (result.reason === "timeout" && this.closeIfCurrent(connection, RELAY_CLOSE_RECONNECT, LINK_RECONNECT_REASON)) {
      this.options.log("runtime_link.reconnect_requested", { runtimeId, instanceId: this.options.instanceId, generation });
      return { outcome: "reconnect_requested", generation };
    }
    const current = this.connection(runtimeId);
    return current ? { outcome: "generation_changed", generation: current.link?.generation ?? null } : { outcome: "no_link" };
  }

  /** Fermeture 4004 : le runtime a été révoqué côté openedbot. */
  revoke(runtimeId: string): boolean {
    const connection = this.registry.get(runtimeId);
    this.replacements.delete(runtimeId);
    if (!connection) return false;
    connection.close(RELAY_CLOSE_REVOKED, "LINK_REVOKED");
    this.release(connection, RELAY_CLOSE_REVOKED, "LINK_REVOKED");
    return true;
  }

  /** Une seule sonde d'enrôlement par ticket à la fois. */
  beginEnrollment(enrollmentId: string): boolean {
    if (this.enrollmentsInProgress.has(enrollmentId)) return false;
    this.enrollmentsInProgress.add(enrollmentId);
    return true;
  }

  endEnrollment(enrollmentId: string): void {
    this.enrollmentsInProgress.delete(enrollmentId);
  }

  enrollmentInProgress(enrollmentId: string): boolean {
    return this.enrollmentsInProgress.has(enrollmentId);
  }

  get size(): number {
    return this.registry.size;
  }

  /** Arrêt du processus : tout le monde est fermé proprement. */
  closeAll(code = 1001, reason = "SERVER_SHUTDOWN"): void {
    if (!this.closing) { this.closing = true; this.persistenceFailures = 0; }
    for (const connection of [...this.registry.values()]) {
      connection.close(code, reason);
      this.release(connection, code, reason);
    }
    this.registry.clear();
    for (const [runtimeId, state] of this.capabilityWrites) {
      if (!state.running) this.capabilityWrites.delete(runtimeId);
    }
  }
}

/** L'étape d'une panne de lien telle que le relais interne la renvoie au worker. */
export function relayFailureStatus(stage: RelayErrStage): number {
  return stage === "before_dispatch" ? 503 : 502;
}
