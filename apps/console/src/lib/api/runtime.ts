import type { RuntimeDirectAccessInput, RuntimeDirectAccessUpdateInput, RuntimeDirectProbeDto, RuntimeEnrollmentStatusDto, RuntimeEnrollmentTicketDto, RuntimeExposureCreatedDto, RuntimeExposureCreateInput, RuntimeExposureDeclareInput, RuntimeExposureDto, RuntimeExposureListDto, RuntimeExposureRevokedDto, RuntimeLinkEventsDto, RuntimeLinkRotationDto, RuntimeLinkRotationMode, RuntimeLinkVerifyDto, RuntimePublicDto, RuntimeTestDto } from "@openedbot/contracts-api";
import { request } from "./http";
import { apiSelf } from "./self";

export const runtimeApi = {
  /** The cloud runtime registered for the organization. */
  runtime: async (): Promise<RuntimePublicDto | null> =>
    (await apiSelf().runtimeConfiguration()).runtime ?? null,
  /**
   * Opens a pairing from the app, for a runtime we own.
   *
   * Never returns a bearer: the ticket only authorizes the script, running
   * on the host, to push THIS runtime's token once.
   */
  openRuntimeEnrollment: (input: { name: string }) =>
    request<RuntimeEnrollmentTicketDto>("/api/runtime-enrollments/open", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  /** The state of an enrollment opened here; the screen polls it while waiting for the host to show up. */
  runtimeEnrollmentStatus: (enrollmentId: string) =>
    request<RuntimeEnrollmentStatusDto>(`/api/runtime-enrollments/${enrollmentId}/status`),
  /** The runtime that serves runs, first, then the one waiting to replace it if there is one. */
  runtimeList: () =>
    request<{ runtimes: RuntimePublicDto[] }>("/api/runtime/list").then((result) => result.runtimes),
  /** Declares a direct runtime: it serves if there is none, otherwise it waits for replacement. */
  createRuntime: (input: RuntimeDirectAccessInput) =>
    request<RuntimePublicDto>("/api/runtime", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  /**
   * Replaces the runtime that serves runs with this one; the API probes it first,
   * then revokes the old one (link closed) in the same transaction.
   */
  replaceRuntime: (runtimeId: string) =>
    request<{ runtime: RuntimePublicDto }>(`/api/runtime/${runtimeId}/replace`, {
      method: "POST",
      body: "{}",
    }).then((result) => result.runtime),
  /**
   * Removes a runtime. The one that serves runs leaves too, but only with
   * `confirm`: the organization then stays without a runtime until it
   * pairs a new one.
   */
  deleteRuntime: (runtimeId: string, confirm = false) =>
    request<{ ok: true }>(`/api/runtime/${runtimeId}`, {
      method: "DELETE",
      body: JSON.stringify({ confirm }),
    }),
  /**
   * Rotates a connector runtime's link token. The new token
   * is returned only here, once: the screen shows it and then forgets it.
   */
  rotateRuntimeLinkToken: (runtimeId: string, mode: RuntimeLinkRotationMode = "maintenance") =>
    request<RuntimeLinkRotationDto>(`/api/runtime/${runtimeId}/link/rotate`, {
      method: "POST",
      body: JSON.stringify({ mode }),
    }),
  /** The connector link's log (connections, replacements, suspicions). */
  runtimeLinkEvents: (runtimeId: string, limit = 50) =>
    request<RuntimeLinkEventsDto>(`/api/runtime/${runtimeId}/link/events?limit=${limit}`),
  /** Pings the connector link, then probes the gateway; a silent link is hung up so the host redials. */
  verifyRuntimeLink: (runtimeId: string) =>
    request<RuntimeLinkVerifyDto>(`/api/runtime/${runtimeId}/link/verify`, { method: "POST", body: "{}" }),
  saveRuntime: (input: {
    name: string;
    url: string;
    token?: string;
    adminSsh?: { host: string; port: number; user: string } | null;
  }) =>
    request<{ runtime: RuntimePublicDto }>("/api/runtime", { method: "PUT", body: JSON.stringify(input) }).then((result) => result.runtime),
  testRuntime: () =>
    request<RuntimeTestDto>("/api/runtime/test", {
      method: "POST",
      body: "{}",
    }),
  /** Probes a draft without saving it: onboarding must prove the connection before creating anything. */
  testRuntimeDraft: (input: Omit<RuntimeDirectAccessInput, "name" | "token"> & { token?: string }) =>
    request<RuntimeDirectProbeDto>("/api/runtime/test-draft", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  testDirectRuntime: (runtimeId: string) =>
    request<RuntimeDirectProbeDto>(`/api/runtime/${runtimeId}/test`, { method: "POST", body: "{}" }),
  updateRuntimeAccess: (runtimeId: string, input: RuntimeDirectAccessUpdateInput) =>
    request<RuntimePublicDto>(`/api/runtime/${runtimeId}/access`, { method: "PUT", body: JSON.stringify(input) }),
  /**
   * Publishes a gateway (provisioned Cloudflare, managed tunnel, Funnel).
   * The install command comes back ONCE: the screen shows it and then forgets it.
   */
  createRuntimeExposure: (input: RuntimeExposureCreateInput) =>
    request<RuntimeExposureCreatedDto>("/api/runtime/exposures", { method: "POST", body: JSON.stringify(input) }),
  /** Publications with no runtime: resumable or revocable from the registry. */
  listRuntimeExposures: () =>
    request<RuntimeExposureListDto>("/api/runtime/exposures").then((result) => result.exposures),
  /** Rereads the publication; off cache, the server probes the hostname. */
  readRuntimeExposure: (exposureId: string) =>
    request<RuntimeExposureDto>(`/api/runtime/exposures/${exposureId}`),
  /** Probes the published hostname with the bearer entered; the Access service token stays on the server. */
  testRuntimeExposure: (exposureId: string, token: string) =>
    request<RuntimeDirectProbeDto>(`/api/runtime/exposures/${exposureId}/test`, { method: "POST", body: JSON.stringify({ token }) }),
  /** Creates the inactive runtime row from the publication and the bearer. */
  declareRuntimeExposure: (exposureId: string, input: RuntimeExposureDeclareInput) =>
    request<RuntimePublicDto>(`/api/runtime/exposures/${exposureId}/declare`, { method: "POST", body: JSON.stringify(input) }),
  deleteRuntimeExposure: (exposureId: string, tailscale?: { clientId: string; clientSecret: string }) =>
    request<RuntimeExposureRevokedDto>(`/api/runtime/exposures/${exposureId}`, { method: "DELETE", body: JSON.stringify(tailscale ? { tailscale } : {}) }),
  runtimes: async () => {
    const runtime = await apiSelf().runtime();
    return { runtimes: runtime ? [runtime] : [] };
  },
};
