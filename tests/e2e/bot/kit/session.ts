/**
 * An operator session on the local API: login, typed calls that fail loud,
 * the linked runtime and the model the run will use. Credentials come from
 * `localCredentials` (LINK_DEV_* or E2E_*), never from a fixture.
 */
import type { RuntimePublicDto } from "@openedbot/contracts-api";
import { localCredentials } from "../../../../scripts/lib/link-dev";
import { passwordLogin } from "../../../../scripts/lib/password-login";
import type { E2eConfig } from "./config";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type ModelChoice = { provider: string; model: string; reasoningEffort: string | null };

type Catalogue = {
  providers: Array<{
    slug: string;
    authenticated: boolean;
    /** A virtual aggregate (`moa`) is "authenticated" without proving any inference. */
    alwaysAuthenticated?: boolean;
    isCurrent: boolean;
    models: Array<{ id: string; isRuntimeDefault: boolean }>;
  }>;
  hasUsableProvider: boolean;
};

export class Session {
  private constructor(
    readonly baseUrl: string,
    readonly organizationId: string,
    private readonly headers: Record<string, string>,
    readonly runtime: RuntimePublicDto & { id: string; name: string },
  ) {}

  static async open(config: E2eConfig, env: Record<string, string | undefined>): Promise<Session> {
    const health = await fetch(`${config.apiUrl}/api/health`).catch(() => null);
    if (!health?.ok) throw new ApiError(health?.status ?? 0, `The local API at ${config.apiUrl} does not answer: is make dev running?`);
    const login = await passwordLogin(config.apiUrl, localCredentials(env));
    if (!login.ok) throw new ApiError(login.status, `Login refused (HTTP ${login.status}).`);
    const auth = (await login.json()) as { organizationId: string; csrfToken: string };
    const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    if (!cookie || !auth.csrfToken) throw new ApiError(login.status, "Login returned no usable session.");
    const headers = {
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-CSRF-Token": auth.csrfToken,
      "X-OHB-Organization": auth.organizationId,
    };
    const response = await fetch(`${config.apiUrl}/api/runtime`, { headers });
    const { runtime } = (await response.json()) as { runtime: RuntimePublicDto | null };
    if (!runtime?.configured || !runtime.id) throw new ApiError(409, "No runtime is registered: a bot cannot be created.");
    if (runtime.reachability === "connector" && runtime.link?.connected !== true) {
      throw new ApiError(409, `The runtime "${runtime.name}" is not linked: run make link-dev-up.`);
    }
    return new Session(config.apiUrl, auth.organizationId, headers, { ...runtime, id: runtime.id, name: runtime.name ?? runtime.id });
  }

  hasFeature(name: string): boolean {
    return this.runtime.linkFeatures?.includes(name) === true;
  }

  raw(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
  }

  /** A call that must answer `expected`; the error carries the status and a bounded body. */
  async api<T>(method: string, path: string, body?: unknown, expected = 200): Promise<T> {
    const response = await this.raw(method, path, body);
    if (response.status !== expected) {
      const text = (await response.text().catch(() => "")).slice(0, 300);
      throw new ApiError(response.status, `${method} ${path.split("?")[0]} answered ${response.status} (expected ${expected}): ${text}`);
    }
    return (expected === 204 ? undefined : await response.json()) as T;
  }

  streamHeaders(): Record<string, string> {
    return { ...this.headers, Accept: "text/event-stream" };
  }

  /**
   * The provider and model every scenario bot uses: the requested one, else
   * the runtime's selection, else the first really authenticated provider.
   */
  async chooseModel(config: E2eConfig): Promise<ModelChoice> {
    const catalogue = await this.api<Catalogue>("GET", `/api/runtimes/${this.runtime.id}/models?fresh=1`);
    if (!catalogue.hasUsableProvider) throw new ApiError(409, "No usable provider on this runtime: a run would fail for lack of a key.");
    const real = (entry: Catalogue["providers"][number]) => entry.authenticated && !entry.alwaysAuthenticated;
    const wanted = config.provider ?? this.runtime.selectedProvider;
    const provider = (wanted ? catalogue.providers.find((entry) => entry.slug === wanted && real(entry)) : undefined)
      ?? (config.provider ? undefined : catalogue.providers.find((entry) => entry.isCurrent && real(entry)) ?? catalogue.providers.find(real));
    if (!provider) throw new ApiError(409, `Provider "${wanted ?? "any"}" is not authenticated on ${this.runtime.name}.`);
    const model = config.model
      ? provider.models.find((entry) => entry.id === config.model)?.id
      : (provider.slug === this.runtime.selectedProvider ? provider.models.find((entry) => entry.id === this.runtime.selectedModel)?.id : undefined)
        ?? provider.models.find((entry) => entry.isRuntimeDefault)?.id
        ?? provider.models[0]?.id;
    if (!model) throw new ApiError(409, `Model "${config.model ?? "default"}" is not served by provider "${provider.slug}".`);
    return { provider: provider.slug, model, reasoningEffort: config.reasoningEffort };
  }

  async close(): Promise<void> {
    await fetch(`${this.baseUrl}/api/auth/logout`, { method: "POST", headers: this.headers }).catch(() => undefined);
  }
}
