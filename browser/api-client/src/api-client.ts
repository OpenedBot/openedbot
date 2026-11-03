import type {
  AgencyClientInvitationDto,
  AgencyClientInvitationPreview,
  InvitableRole,
  OrganizationMemberInvitationDto,
  OrganizationMemberInvitationPreview,
} from "@openedbot/contracts-api";
import type { OrganizationEvent, StreamCursor, StreamGap } from "@openedbot/contracts-events";

export type { OrganizationEvent, StreamGap } from "@openedbot/contracts-events";

export type AuthStore = {
  readAccessToken(): Promise<string | null>;
  refresh(): Promise<string | null>;
};

/**
 * L'erreur HTTP de tout client openedbot (`status`, `code`, `requestId`). La console
 * (`ApiError`) et le backoffice (`StaffApiError`) l'étendent sans changer de nom.
 */
export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    /** L'en-tête `X-Request-Id` de la réponse, `null`/absent si la requête n'a jamais atteint l'API. */
    readonly requestId?: string | null,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export type ApiClientOptions = {
  baseUrl: string;
  organizationId: () => string | null;
  actingFleetId?: () => string | null;
  auth?: AuthStore;
  csrfToken?: () => string | null;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
};

export class ApiClient {
  private readonly fetcher: (input: string, init?: RequestInit) => Promise<Response>;

  constructor(private readonly options: ApiClientOptions) {
    const configuredFetch = options.fetch;
    this.fetcher = configuredFetch
      ? (input, init) => configuredFetch(input, init)
      : (input, init) => globalThis.fetch(input, init);
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return this.attempt<T>(path, init, true);
  }

  async *events(input: {
    cursor: number;
    getCursor?: () => number;
    signal: AbortSignal;
    onOpen?: () => void;
    onError?: (error: unknown) => void;
    /**
     * `(from, to]` ne sera pas rendu sur cette connexion : borne de rejeu
     * (en tête de flux), ou `reason: "slow_consumer"` (juste avant la
     * fermeture ; la reconnexion reprend à `from`).
     */
    onGap?: (gap: StreamGap) => void;
    /**
     * Ne recevoir que ces fils (et les événements sans fil). Absent ou vide :
     * toute l'organisation.
     */
    threadIds?: readonly string[];
    /** Flux filtré : le serveur a écarté jusqu'à `cursor`, la reprise repart de là. */
    onCursor?: (cursor: number) => void;
  }): AsyncGenerator<OrganizationEvent> {
    const organizationId = this.requireOrganization();
    let cursor = input.cursor;
    let attempt = 0;
    const threadQuery = (input.threadIds ?? []).map((id) => `&threadId=${encodeURIComponent(id)}`).join("");
    while (!input.signal.aborted) {
      let slowConsumer = false;
      try {
        if (input.getCursor) cursor = Math.max(cursor, input.getCursor());
        const response = await this.raw(`/api/events?cursor=${cursor}${threadQuery}`, {
          headers: { Accept: "text/event-stream", "Last-Event-ID": String(cursor) },
          signal: input.signal,
        });
        if (!response.ok) {
          const error = await responseError(response);
          if (error.status === 401 && this.options.auth && await this.options.auth.refresh()) {
            attempt = 0;
            continue;
          }
          throw error;
        }
        if (!response.body) throw new ApiClientError(502, "Le flux cloud est vide.", "EVENT_STREAM_EMPTY");
        attempt = 0;
        input.onOpen?.();
        for await (const frame of parseEventStream(response.body)) {
          if (frame.event === "stream.revoked") {
            if (typeof frame.data === "object" && frame.data !== null
              && (frame.data as { organizationId?: unknown }).organizationId === organizationId) {
              throw new ApiClientError(403, "Vous n’avez plus accès à cet espace.", "WORKSPACE_ACCESS_REVOKED");
            }
            continue;
          }
          if (frame.event === "stream.gap") {
            const gap = readStreamGap(frame.data);
            if (gap && gap.organizationId === organizationId) {
              if (gap.reason === "slow_consumer") slowConsumer = true;
              input.onGap?.(gap);
            }
            continue;
          }
          if (frame.event === "stream.cursor") {
            const position = readStreamCursor(frame.data);
            if (position && position.organizationId === organizationId && position.cursor > cursor) {
              cursor = position.cursor;
              input.onCursor?.(cursor);
            }
            continue;
          }
          const event = frame.data as OrganizationEvent;
          if (event.organizationId !== organizationId) continue;
          // Pas de curseur : fan-out avant commit. On livre la trame sans
          // bouger la reprise, sinon Last-Event-ID sauterait des lignes
          // plus basses encore non committées.
          if (typeof event.cursor !== "number" || !Number.isSafeInteger(event.cursor)) {
            yield event;
            continue;
          }
          if (event.cursor <= cursor) continue;
          cursor = event.cursor;
          yield event;
        }
        if (!input.signal.aborted) {
          if (slowConsumer) {
            attempt += 1;
            await wait(eventStreamRetryDelay(attempt, "slow_consumer"), input.signal);
            continue;
          }
          throw new ApiClientError(502, "Le flux cloud a été interrompu.", "EVENT_STREAM_INTERRUPTED");
        }
      } catch (error) {
        if (input.signal.aborted) return;
        // Le serveur a déjà annoncé `slow_consumer` puis coupé : ce n'est pas
        // une panne. On ne remonte pas l'erreur (pas de `console.error`) et
        // on ne retente pas à 500 ms, ce qui renfoncerait le client lent.
        if (slowConsumer) {
          slowConsumer = false;
          attempt += 1;
          await wait(eventStreamRetryDelay(attempt, "slow_consumer"), input.signal);
          continue;
        }
        input.onError?.(error);
        if (input.signal.aborted || (error instanceof ApiClientError && error.code === "WORKSPACE_ACCESS_REVOKED")) return;
        attempt += 1;
        await wait(eventStreamRetryDelay(attempt), input.signal);
      }
    }
  }

  private async attempt<T>(path: string, init: RequestInit, mayRefresh: boolean): Promise<T> {
    const response = await this.raw(path, init);
    if (response.status === 204) return undefined as T;
    if (!response.ok) {
      const error = await responseError(response);
      if (mayRefresh && error.status === 401 && this.options.auth) {
        const token = await this.options.auth.refresh();
        if (token) return this.attempt<T>(path, init, false);
      }
      throw error;
    }
    return (await response.json()) as T;
  }

  private async raw(path: string, init: RequestInit): Promise<Response> {
    const organizationId = this.requireOrganization();
    const token = await this.options.auth?.readAccessToken();
    const method = (init.method ?? "GET").toUpperCase();
    const csrf = this.options.csrfToken?.();
    const actingFleetId = this.options.actingFleetId?.();
    return this.fetcher(`${this.options.baseUrl.replace(/\/+$/, "")}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        "X-OpenedBot-Organization": organizationId,
        ...(actingFleetId ? { "X-OpenedBot-Fleet": actingFleetId } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(csrf && !["GET", "HEAD", "OPTIONS"].includes(method) ? { "X-CSRF-Token": csrf } : {}),
        ...init.headers,
      },
    });
  }

  private requireOrganization(): string {
    const organizationId = this.options.organizationId();
    if (!organizationId) {
      throw new ApiClientError(400, "Aucune organisation active.", "ORGANIZATION_REQUIRED");
    }
    return organizationId;
  }
}

async function responseError(response: Response): Promise<ApiClientError> {
  const body = (await response.json().catch(() => null)) as
    | { error?: { message?: unknown; code?: unknown }; message?: unknown; code?: unknown }
    | null;
  const message = body?.error?.message ?? body?.message;
  const code = body?.error?.code ?? body?.code;
  return new ApiClientError(
    response.status,
    typeof message === "string" ? message : `L’API cloud a répondu HTTP ${response.status}.`,
    typeof code === "string" ? code : "API_ERROR",
  );
}

export type EventStreamFrame = { event: string | null; data: unknown };

function readStreamGap(value: unknown): StreamGap | null {
  if (typeof value !== "object" || value === null) return null;
  const gap = value as Record<string, unknown>;
  if (typeof gap.organizationId !== "string") return null;
  if (typeof gap.from !== "number" || typeof gap.to !== "number") return null;
  return {
    organizationId: gap.organizationId,
    from: gap.from,
    to: gap.to,
    ...(gap.reason === "slow_consumer" ? { reason: gap.reason } : {}),
  };
}

function readStreamCursor(value: unknown): StreamCursor | null {
  if (typeof value !== "object" || value === null) return null;
  const position = value as Record<string, unknown>;
  if (typeof position.organizationId !== "string") return null;
  if (typeof position.cursor !== "number" || !Number.isSafeInteger(position.cursor)) return null;
  return { organizationId: position.organizationId, cursor: position.cursor };
}

/**
 * Trames SSE, avec leur nom (`event:`) : `stream.gap` et `stream.cursor` ne
 * sont pas des événements d'organisation et ne se rendent pas comme un
 * événement de fil ; seul `stream.cursor` avance le curseur.
 */
export async function* parseEventStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<EventStreamFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replaceAll("\r\n", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        const lines = frame.split("\n");
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        const eventLine = lines.find((line) => line.startsWith("event:"));
        yield { event: eventLine ? eventLine.slice(6).trim() : null, data: JSON.parse(data) as unknown };
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Délai avant de rouvrir le flux. Un `slow_consumer` part à 5 s (puis 10, 20,
 * plafond 30) : le premier repli générique est 500 ms, et marteler un client
 * déjà lent ne fait que le recouper.
 */
export function eventStreamRetryDelay(attempt: number, reason?: "slow_consumer"): number {
  if (reason === "slow_consumer") return Math.min(30_000, 5_000 * 2 ** Math.min(Math.max(attempt, 1) - 1, 4));
  return Math.min(5_000, 250 * 2 ** Math.min(attempt, 5));
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

/** Shared invitation endpoints; callers supply their existing session-aware transport. */
export function agencyInvitationApi(request: <T>(path: string, init?: RequestInit) => Promise<T>) {
  const agencyHeaders = (id: string) => ({ "X-OpenedBot-Organization": id });
  return {
    previewAgencyInvitation: (token: string) => request<AgencyClientInvitationPreview>(`/api/pro/agency/invite/${encodeURIComponent(token)}`),
    registerAgencyInvitee: (token: string, password: string) => request<{ user: { id: string; email: string }; organizationId: null; csrfToken: string }>(`/api/pro/agency/invite/${encodeURIComponent(token)}/register`, {
      method: "POST", body: JSON.stringify({ password }),
    }),
    respondToAgencyInvitation: (token: string, accept: boolean) => request<{ status: "accepted" | "declined"; organizationId: string | null; organizationCreated: boolean }>(`/api/pro/agency/invite/${encodeURIComponent(token)}/${accept ? "accept" : "decline"}`, {
      method: "POST", body: "{}",
    }),
    agencyInvitations: (agencyId: string) => request<{ invitations: AgencyClientInvitationDto[] }>("/api/pro/agency/invitations", { headers: agencyHeaders(agencyId) }),
    inviteAgencyClient: (agencyId: string, email: string, locale: string) => request<AgencyClientInvitationDto>("/api/pro/agency/invitations", {
      method: "POST", headers: agencyHeaders(agencyId), body: JSON.stringify({ email, locale }),
    }),
    resendAgencyInvitation: (agencyId: string, id: string) => request<AgencyClientInvitationDto>(`/api/pro/agency/invitations/${encodeURIComponent(id)}/resend`, {
      method: "POST", headers: agencyHeaders(agencyId), body: "{}",
    }),
    cancelAgencyInvitation: (agencyId: string, id: string) => request<void>(`/api/pro/agency/invitations/${encodeURIComponent(id)}`, {
      method: "DELETE", headers: agencyHeaders(agencyId),
    }),
  };
}

/** Shared member invitation endpoints for the tenant and public invite flows. */
export function memberInvitationApi(
  request: <T>(path: string, init?: RequestInit) => Promise<T>,
  publicRequest: <T>(path: string, init?: RequestInit) => Promise<T> = request,
) {
  return {
    organizationInvitations: () => request<{ invitations: OrganizationMemberInvitationDto[] }>("/api/organization/invitations"),
    inviteOrganizationMember: (email: string, role: InvitableRole, locale: string) => request<OrganizationMemberInvitationDto>("/api/organization/invitations", {
      method: "POST", body: JSON.stringify({ email, role, locale }),
    }),
    resendOrganizationInvitation: (id: string) => request<OrganizationMemberInvitationDto>(`/api/organization/invitations/${encodeURIComponent(id)}/resend`, {
      method: "POST", body: "{}",
    }),
    cancelOrganizationInvitation: (id: string) => request<void>(`/api/organization/invitations/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
    previewMemberInvitation: (token: string) => publicRequest<OrganizationMemberInvitationPreview>(`/api/invite/member/${encodeURIComponent(token)}`),
    registerMemberInvitee: (token: string, password: string) => publicRequest<{ user: { id: string; email: string }; organizationId: null; csrfToken: string }>(`/api/invite/member/${encodeURIComponent(token)}/register`, {
      method: "POST", body: JSON.stringify({ password }),
    }),
    respondToMemberInvitation: (token: string, accept: boolean) => publicRequest<{ status: "accepted" | "declined"; organizationId: string | null }>(`/api/invite/member/${encodeURIComponent(token)}/${accept ? "accept" : "decline"}`, {
      method: "POST", body: "{}",
    }),
  };
}
