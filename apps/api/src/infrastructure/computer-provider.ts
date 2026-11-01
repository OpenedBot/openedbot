import { asRecord } from "@openedbot/contracts-primitives";
import { createHash } from "node:crypto";
import type { ComputerProviderConfig } from "./config";

const READY_STATES = new Set(["idle", "ready", "running"]);
const OFF_STATES = new Set(["archived", "stopped", "off"]);
const DEFAULT_TTL_SECONDS = 8 * 60 * 60;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_CAPTURE_BYTES = 5 * 1024 * 1024;
const SCREENSHOT_PATH = "/tmp/ohb-computer-panel.jpg";
const SCREENSHOT_COMMAND = [
  "export DISPLAY=${DISPLAY:-:0}",
  `f=${SCREENSHOT_PATH}`,
  'scrot -o -q 70 "$f" 2>/dev/null || import -window root -quality 70 "$f" 2>/dev/null || ffmpeg -y -f x11grab -i "$DISPLAY" -frames:v 1 -q:v 7 "$f" >/dev/null 2>&1',
  'test -s "$f" && echo OHB_CAPTURED',
].join("; ");

export type ComputerMachineState = "off" | "provisioning" | "ready" | "error";

export type ComputerProviderStatus = {
  configured: boolean;
  state: ComputerMachineState;
  providerState: string | null;
};

export type ComputerCapture = {
  mediaType: "image/jpeg" | "image/png";
  base64: string;
  capturedAt: string;
};

export interface ComputerProvider {
  readonly kind: "disabled" | "box";
  status(workspaceKey: string): Promise<ComputerProviderStatus>;
  start(workspaceKey: string, displayName: string): Promise<ComputerProviderStatus>;
  open(workspaceKey: string): Promise<{ url: string }>;
  capture(workspaceKey: string): Promise<ComputerCapture>;
  stop(workspaceKey: string): Promise<ComputerProviderStatus>;
}

export class ComputerProviderError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ComputerProviderError";
  }
}

export function createComputerProvider(config: ComputerProviderConfig): ComputerProvider {
  return config.provider === "box"
    ? new BoxComputerProvider(config)
    : new DisabledComputerProvider();
}

class DisabledComputerProvider implements ComputerProvider {
  readonly kind = "disabled" as const;

  async status(): Promise<ComputerProviderStatus> {
    return { configured: false, state: "off", providerState: null };
  }

  async start(): Promise<never> { throw disabledError(); }
  async open(): Promise<never> { throw disabledError(); }
  async capture(): Promise<never> { throw disabledError(); }
  async stop(): Promise<never> { throw disabledError(); }
}

function disabledError() {
  return new ComputerProviderError(
    409,
    "COMPUTER_PROVIDER_DISABLED",
    "Aucun fournisseur Computer n’est configuré pour ce déploiement.",
  );
}

type Box = { id: string; name?: string; state: string };
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Persistent Box/ascii.dev adapter. The provider owns lifecycle and disk;
 * openedbot owns tenant scoping, authorization and never exposes its API
 * credential or its raw error bodies to clients.
 */
export class BoxComputerProvider implements ComputerProvider {
  readonly kind = "box" as const;
  private readonly ids = new Map<string, string>();
  /**
   * Start and stop change the same provider resource. Keep one FIFO tail per
   * bot so a stop accepted while creation is in flight cannot observe "no
   * box", return `off`, and then let that older start create a live machine.
   * The API route also takes a PostgreSQL advisory lock for cross-replica
   * ordering; this queue protects direct provider callers and one replica.
   */
  private readonly lifecycleTails = new Map<string, Promise<void>>();

  constructor(
    private readonly config: Extract<ComputerProviderConfig, { provider: "box" }>,
    private readonly fetcher: Fetcher = globalThis.fetch,
    private readonly pause: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  async status(workspaceKey: string): Promise<ComputerProviderStatus> {
    const box = await this.find(workspaceKey);
    return box
      ? { configured: true, state: normalizeState(box.state), providerState: box.state }
      : { configured: true, state: "off", providerState: null };
  }

  async start(workspaceKey: string, displayName: string): Promise<ComputerProviderStatus> {
    return this.serializeLifecycle(workspaceKey, () => this.startOnce(workspaceKey, displayName));
  }

  private async startOnce(workspaceKey: string, _displayName: string): Promise<ComputerProviderStatus> {
    let box = await this.find(workspaceKey);
    let created = false;
    if (!box) {
      const body = await this.json("/boxes", {
        method: "POST",
        headers: {
          // Same key across API replicas during a concurrent-start window,
          // but a later recovery can create a genuinely new machine.
          "Idempotency-Key": `ohb-computer-${hash(workspaceKey).slice(0, 16)}-${Math.floor(Date.now() / 300_000)}`,
        },
        body: JSON.stringify({ ttlSeconds: DEFAULT_TTL_SECONDS, noEnv: true }),
      }, 30_000);
      box = readBox(body);
      if (!box) throw invalidResponse("Le fournisseur n’a pas renvoyé l’ordinateur créé.");
      created = true;
      this.ids.set(workspaceKey, box.id);
      try {
        await this.json(`/boxes/${encodeURIComponent(box.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ name: machineName(workspaceKey) }),
        }, 20_000);
      } catch (error) {
        await this.removeCreated(box.id).catch(() => undefined);
        this.ids.delete(workspaceKey);
        throw error;
      }
    } else if (OFF_STATES.has(box.state)) {
      await this.json(`/boxes/${encodeURIComponent(box.id)}/resume`, { method: "POST" }, 20_000);
    }

    const ready = await this.waitReady(box.id, 90_000);
    if (!ready) {
      if (created) {
        await this.removeCreated(box.id).catch(() => undefined);
        this.ids.delete(workspaceKey);
      }
      throw new ComputerProviderError(
        504,
        "COMPUTER_PROVISIONING_TIMEOUT",
        "L’ordinateur n’est pas devenu prêt dans le délai imparti.",
      );
    }
    return { configured: true, state: "ready", providerState: ready.state };
  }

  async open(workspaceKey: string): Promise<{ url: string }> {
    const box = await this.requireReady(workspaceKey);
    const startedAt = Date.now();
    while (Date.now() - startedAt < 45_000) {
      const body = await this.json(`/boxes/${encodeURIComponent(box.id)}/desktop?vnc=1`, {
        method: "POST",
      }, 12_000);
      const url = desktopUrl(body);
      if (url) return { url: safeDesktopUrl(url) };
      if (!isProvisioning(body)) break;
      await this.pause(2_000);
    }
    const fallback = await this.json(`/boxes/${encodeURIComponent(box.id)}/desktop`, {
      method: "POST",
    }, 15_000);
    const url = desktopUrl(fallback);
    if (!url) throw invalidResponse("Le fournisseur n’a pas renvoyé de lien de bureau.");
    return { url: safeDesktopUrl(url) };
  }

  async capture(workspaceKey: string): Promise<ComputerCapture> {
    const box = await this.requireReady(workspaceKey);
    const command = await this.json(`/boxes/${encodeURIComponent(box.id)}/commands`, {
      method: "POST",
      body: JSON.stringify({ command: SCREENSHOT_COMMAND }),
    }, 65_000);
    const result = asRecord(command);
    if (result?.exitCode !== 0 || typeof result.stdout !== "string" || !result.stdout.includes("OHB_CAPTURED")) {
      throw new ComputerProviderError(502, "COMPUTER_CAPTURE_FAILED", "La capture du bureau a échoué.");
    }

    const artifact = await this.raw(
      `/boxes/${encodeURIComponent(box.id)}/artifacts?path=${encodeURIComponent(SCREENSHOT_PATH)}`,
      20_000,
    );
    const mediaType = captureMediaType(artifact);
    return {
      mediaType,
      base64: Buffer.from(artifact).toString("base64"),
      capturedAt: new Date().toISOString(),
    };
  }

  async stop(workspaceKey: string): Promise<ComputerProviderStatus> {
    return this.serializeLifecycle(workspaceKey, () => this.stopOnce(workspaceKey));
  }

  private async stopOnce(workspaceKey: string): Promise<ComputerProviderStatus> {
    const box = await this.find(workspaceKey);
    if (!box) return { configured: true, state: "off", providerState: null };
    await this.json(`/boxes/${encodeURIComponent(box.id)}/stop`, { method: "POST" }, 20_000);
    const stopped = await this.waitOff(box.id, 30_000);
    if (!stopped) {
      throw new ComputerProviderError(
        504,
        "COMPUTER_STOP_TIMEOUT",
        "L’arrêt de l’ordinateur n’a pas pu être confirmé dans le délai imparti.",
      );
    }
    return { configured: true, state: "off", providerState: stopped.state };
  }

  private serializeLifecycle<T>(workspaceKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTails.get(workspaceKey) ?? Promise.resolve();
    // A failed operation releases the queue: a later explicit stop must still
    // be able to clean up a provider resource left by a partial start.
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.lifecycleTails.set(workspaceKey, tail);
    void tail.then(() => {
      if (this.lifecycleTails.get(workspaceKey) === tail) this.lifecycleTails.delete(workspaceKey);
    });
    return result;
  }

  private async requireReady(workspaceKey: string): Promise<Box> {
    const box = await this.find(workspaceKey);
    if (!box) {
      throw new ComputerProviderError(409, "COMPUTER_NOT_STARTED", "Démarrez d’abord l’ordinateur de ce bot.");
    }
    if (!READY_STATES.has(box.state)) {
      throw new ComputerProviderError(409, "COMPUTER_NOT_READY", "L’ordinateur de ce bot n’est pas prêt.");
    }
    return box;
  }

  private async find(workspaceKey: string): Promise<Box | null> {
    const cached = this.ids.get(workspaceKey);
    if (cached) {
      try {
        const box = readBox(await this.json(`/boxes/${encodeURIComponent(cached)}`, {}, 12_000));
        if (box) return box;
      } catch (error) {
        if (!(error instanceof ComputerProviderError) || error.status !== 404) throw error;
      }
      this.ids.delete(workspaceKey);
    }
    const record = asRecord(await this.json("/boxes", {}, 15_000));
    const boxes = Array.isArray(record?.boxes) ? record.boxes : [];
    const expected = machineName(workspaceKey);
    const found = boxes.map(readBox).find((candidate) => candidate?.name === expected) ?? null;
    if (found) this.ids.set(workspaceKey, found.id);
    return found;
  }

  private async waitReady(boxId: string, budgetMs: number): Promise<Box | null> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < budgetMs) {
      const box = readBox(await this.json(`/boxes/${encodeURIComponent(boxId)}`, {}, 12_000));
      if (!box) throw invalidResponse("Le statut Computer du fournisseur est invalide.");
      if (READY_STATES.has(box.state)) return box;
      if (box.state === "error") return null;
      await this.pause(2_500);
    }
    return null;
  }

  private async waitOff(boxId: string, budgetMs: number): Promise<Box | null> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < budgetMs) {
      const box = readBox(await this.json(`/boxes/${encodeURIComponent(boxId)}`, {}, 12_000));
      if (!box) throw invalidResponse("Le statut Computer du fournisseur est invalide.");
      if (OFF_STATES.has(box.state)) return box;
      if (box.state === "error") return null;
      await this.pause(1_000);
    }
    return null;
  }

  private async removeCreated(boxId: string): Promise<void> {
    await this.json(`/boxes/${encodeURIComponent(boxId)}`, {
      method: "DELETE",
      headers: { "X-Ascii-Confirm-Delete": boxId },
    }, 20_000);
  }

  private async json(path: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<unknown> {
    const response = await this.request(path, init, timeoutMs);
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw invalidResponse("La réponse du fournisseur est trop volumineuse.");
    }
    const bytes = await readBoundedBytes(response, MAX_JSON_BYTES, "La réponse du fournisseur est trop volumineuse.");
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw invalidResponse("La réponse du fournisseur n’est pas un JSON valide.");
    }
  }

  private async raw(path: string, timeoutMs: number): Promise<Uint8Array> {
    const response = await this.request(path, {}, timeoutMs);
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_CAPTURE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw invalidResponse("La capture du fournisseur est trop volumineuse.");
    }
    const bytes = await readBoundedBytes(response, MAX_CAPTURE_BYTES, "La capture du fournisseur est trop volumineuse.");
    if (bytes.byteLength < 16 || bytes.byteLength > MAX_CAPTURE_BYTES) {
      throw invalidResponse("La taille de la capture du fournisseur est invalide.");
    }
    return bytes;
  }

  private async request(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.config.apiUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.config.token}`,
          "content-type": "application/json",
          ...init.headers,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ComputerProviderError(504, "COMPUTER_PROVIDER_TIMEOUT", "Le fournisseur Computer est inaccessible.");
    }
    if (response.ok) return response;
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 402) {
      throw new ComputerProviderError(402, "COMPUTER_PLAN_REQUIRED", "Le forfait du fournisseur ne permet pas de démarrer un ordinateur.");
    }
    if (response.status === 429) {
      throw new ComputerProviderError(503, "COMPUTER_PROVIDER_RATE_LIMITED", "Le fournisseur Computer limite temporairement les requêtes.", 60);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ComputerProviderError(502, "COMPUTER_PROVIDER_AUTH_FAILED", "Le fournisseur Computer a refusé les identifiants du déploiement.");
    }
    if (response.status === 404) {
      throw new ComputerProviderError(404, "COMPUTER_NOT_FOUND", "L’ordinateur demandé n’existe plus chez le fournisseur.");
    }
    throw new ComputerProviderError(502, "COMPUTER_PROVIDER_ERROR", "Le fournisseur Computer a renvoyé une erreur.");
  }
}

async function readBoundedBytes(response: Response, maxBytes: number, message: string): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw invalidResponse(message);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function normalizeState(state: string): ComputerMachineState {
  if (READY_STATES.has(state)) return "ready";
  if (OFF_STATES.has(state)) return "off";
  if (["creating", "starting", "provisioning", "resuming", "stopping", "archiving"].includes(state)) {
    return "provisioning";
  }
  return "error";
}

function readBox(value: unknown): Box | null {
  const record = asRecord(value);
  const candidate = asRecord(record?.box) ?? record;
  return candidate && typeof candidate.id === "string" && typeof candidate.state === "string"
    ? { id: candidate.id, state: candidate.state, ...(typeof candidate.name === "string" ? { name: candidate.name } : {}) }
    : null;
}

function desktopUrl(value: unknown): string | null {
  const record = asRecord(value);
  const candidate = record?.desktopUrl ?? record?.url;
  return typeof candidate === "string" && candidate.length <= 8_192 ? candidate : null;
}

function isProvisioning(value: unknown): boolean {
  return asRecord(value)?.provisioning === true;
}

function safeDesktopUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidResponse("Le lien de bureau du fournisseur est invalide.");
  }
  if (url.protocol !== "https:") {
    throw invalidResponse("Le lien de bureau du fournisseur n’utilise pas HTTPS.");
  }
  url.username = "";
  url.password = "";
  return url.toString();
}

function captureMediaType(bytes: Uint8Array): "image/jpeg" | "image/png" {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return "image/jpeg";
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "image/png";
  throw invalidResponse("La capture du fournisseur n’est ni un JPEG ni un PNG valide.");
}

function machineName(workspaceKey: string): string {
  return `ohb-${hash(workspaceKey).slice(0, 20)}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function invalidResponse(message: string): ComputerProviderError {
  return new ComputerProviderError(502, "COMPUTER_PROVIDER_RESPONSE_INVALID", message);
}
