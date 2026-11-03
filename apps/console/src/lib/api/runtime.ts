import type { RuntimeDirectAccessInput, RuntimeDirectAccessUpdateInput, RuntimeDirectProbeDto, RuntimeEnrollmentStatusDto, RuntimeEnrollmentTicketDto, RuntimeExposureCreatedDto, RuntimeExposureCreateInput, RuntimeExposureDeclareInput, RuntimeExposureDto, RuntimeExposureListDto, RuntimeExposureRevokedDto, RuntimeLinkEventsDto, RuntimeLinkRotationDto, RuntimeLinkRotationMode, RuntimeLinkVerifyDto, RuntimePublicDto, RuntimeTestDto } from "@openedbot/contracts-api";
import { request } from "./http";
import { apiSelf } from "./self";

export const runtimeApi = {
  /** Le runtime cloud enregistré pour l’organisation. */
  runtime: async (): Promise<RuntimePublicDto | null> =>
    (await apiSelf().runtimeConfiguration()).runtime ?? null,
  /**
   * Ouvre un appairage depuis l application, pour un runtime qu on possede.
   *
   * Ne renvoie jamais de bearer : le ticket autorise seulement le script, joue
   * sur l hote, a pousser le token de CE runtime une fois.
   */
  openRuntimeEnrollment: (input: { name: string }) =>
    request<RuntimeEnrollmentTicketDto>("/api/runtime-enrollments/open", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  /** L'état d'un enrôlement ouvert ici ; l'écran le sonde en attendant que l'hôte se présente. */
  runtimeEnrollmentStatus: (enrollmentId: string) =>
    request<RuntimeEnrollmentStatusDto>(`/api/runtime-enrollments/${enrollmentId}/status`),
  /** Le runtime qui sert les runs, en tête, puis celui qui attend de le remplacer s'il y en a un. */
  runtimeList: () =>
    request<{ runtimes: RuntimePublicDto[] }>("/api/runtime/list").then((result) => result.runtimes),
  /** Déclare un runtime direct : il sert s'il n'y en a aucun, sinon il attend le remplacement. */
  createRuntime: (input: RuntimeDirectAccessInput) =>
    request<RuntimePublicDto>("/api/runtime", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  /**
   * Remplace le runtime qui sert les runs par celui-ci ; l'API le sonde avant,
   * puis révoque l'ancien (lien fermé) dans la même transaction.
   */
  replaceRuntime: (runtimeId: string) =>
    request<{ runtime: RuntimePublicDto }>(`/api/runtime/${runtimeId}/replace`, {
      method: "POST",
      body: "{}",
    }).then((result) => result.runtime),
  /**
   * Retire un runtime. Celui qui sert les runs part aussi, mais seulement avec
   * `confirm` : l'organisation reste alors sans runtime tant qu'elle n'en
   * appaire pas un nouveau.
   */
  deleteRuntime: (runtimeId: string, confirm = false) =>
    request<{ ok: true }>(`/api/runtime/${runtimeId}`, {
      method: "DELETE",
      body: JSON.stringify({ confirm }),
    }),
  /**
   * Fait tourner le jeton de lien d'un runtime connector. Le nouveau jeton
   * n'est rendu qu'ici, une fois : l'écran l'affiche puis l'oublie.
   */
  rotateRuntimeLinkToken: (runtimeId: string, mode: RuntimeLinkRotationMode = "maintenance") =>
    request<RuntimeLinkRotationDto>(`/api/runtime/${runtimeId}/link/rotate`, {
      method: "POST",
      body: JSON.stringify({ mode }),
    }),
  /** Le journal du lien connecteur (connexions, remplacements, soupçons). */
  runtimeLinkEvents: (runtimeId: string, limit = 50) =>
    request<RuntimeLinkEventsDto>(`/api/runtime/${runtimeId}/link/events?limit=${limit}`),
  /** Ping du lien connecteur, puis sonde du gateway ; un lien muet est raccroché pour que l'hôte redial. */
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
  /** Sonde un brouillon sans l’enregistrer : l’accueil doit prouver la connexion avant de créer quoi que ce soit. */
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
   * OHB-75 : publie un gateway (Cloudflare provisionné, tunnel géré, Funnel).
   * La commande d'installation revient UNE fois : l'écran l'affiche puis l'oublie.
   */
  createRuntimeExposure: (input: RuntimeExposureCreateInput) =>
    request<RuntimeExposureCreatedDto>("/api/runtime/exposures", { method: "POST", body: JSON.stringify(input) }),
  /** Les publications sans runtime : reprenables ou révocables depuis le registre. */
  listRuntimeExposures: () =>
    request<RuntimeExposureListDto>("/api/runtime/exposures").then((result) => result.exposures),
  /** Relit la publication ; hors cache, le serveur sonde le hostname. */
  readRuntimeExposure: (exposureId: string) =>
    request<RuntimeExposureDto>(`/api/runtime/exposures/${exposureId}`),
  /** Sonde le hostname publié avec le bearer saisi ; le service token Access est côté serveur. */
  testRuntimeExposure: (exposureId: string, token: string) =>
    request<RuntimeDirectProbeDto>(`/api/runtime/exposures/${exposureId}/test`, { method: "POST", body: JSON.stringify({ token }) }),
  /** Crée la ligne runtime inactive à partir de la publication et du bearer. */
  declareRuntimeExposure: (exposureId: string, input: RuntimeExposureDeclareInput) =>
    request<RuntimePublicDto>(`/api/runtime/exposures/${exposureId}/declare`, { method: "POST", body: JSON.stringify(input) }),
  deleteRuntimeExposure: (exposureId: string, tailscale?: { clientId: string; clientSecret: string }) =>
    request<RuntimeExposureRevokedDto>(`/api/runtime/exposures/${exposureId}`, { method: "DELETE", body: JSON.stringify(tailscale ? { tailscale } : {}) }),
  runtimes: async () => {
    const runtime = await apiSelf().runtime();
    return { runtimes: runtime ? [runtime] : [] };
  },
};
