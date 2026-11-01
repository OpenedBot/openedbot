// Frozen renderer bridge contract. The openedbot console consumes this exact shape
// from `window.__OHB_NATIVE__`; any change here is a breaking change on the
// console side. The refresh token never crosses this boundary.
export type OhbNativeBridge = {
  /** Current access token, refreshed when expired (60 s margin). null when signed out. */
  readAccessToken(): Promise<string | null>;
  /** Forces a rotation. null when the refresh is refused (401): the shell then shows signin.html. */
  refresh(): Promise<string | null>;
  /** Opens in the system browser. Only https URLs on the console or api origin are accepted, otherwise rejects. */
  openExternal(url: string): Promise<void>;
  /** Clears the tokens and shows signin.html. */
  signOut(): Promise<void>;
  shell: { platform: "windows"; version: string };
};

declare global {
  interface Window {
    __OHB_NATIVE__?: OhbNativeBridge;
  }
}

// State pushed from the main process to the local sign-in page.
export type SigninState =
  | { status: "idle"; reason?: "signed-out" | "session-lost" }
  /** Google: the system browser is open, the shell polls the claim. */
  | { status: "waiting" }
  /** Email and password: the request is in flight. */
  | { status: "submitting" }
  /** Email and password were valid; the local page must collect the e-mail code. */
  | { status: "code_required" }
  /**
   * `code` names the failure so the page can say it in the reader's language
   * (an API code such as CREDENTIALS_INVALID, or a shell one such as
   * LOOPBACK_BUSY); `message` is the French fallback, `params` fills it.
   */
  | { status: "error"; code: string; message: string; params?: Record<string, string> };

/** What the sign-in page needs from the API, read by the main process (the page cannot reach the network). */
export type SigninContext = {
  /** `null` when the API did not answer: the page says so and keeps both doors open. */
  providers: {
    google: { enabled: true } | { enabled: false; reason: "not_configured" | "origin_unsupported" };
    password: { enabled: boolean };
    /** Seeded accounts, published by a development API only. */
    devAccounts: Array<{ email: string; password: string; role: "owner" | "agency" }>;
  } | null;
  /** Legal documents the deployment actually serves; opened in the browser. */
  legal: LegalSlug[];
  /**
   * The deployment tier: what the API says (`/api/health`, its
   * OHB_DEPLOY_ENV), else what the shell infers from the API origin. The page
   * badges every tier but production.
   */
  environment: DeployEnvironment;
};

export type DeployEnvironment = "dev" | "preprod" | "prod";

export type LegalSlug = "mentions" | "privacy" | "terms";

// Email and password typed on the local sign-in page, sent to the main process
// which runs PKCE and POST /api/auth/native/authorize. Never logged.
export type PasswordCredentials = { email: string; password: string; emailCode?: string };

// The sandboxed preload cannot import runtime values from other files, so it
// repeats these literals and checks them against this union with `satisfies`.
export type IpcChannel =
  | "ohb:read-access-token"
  | "ohb:refresh"
  | "ohb:open-external"
  | "ohb:sign-out"
  | "ohb:theme"
  | "ohb:text-zoom"
  | "ohb:text-zoom-initial"
  | "auth:start"
  | "auth:password"
  | "auth:cancel"
  | "auth:context"
  | "auth:open-legal"
  | "auth:state";

// Réglages › Apparence › Taille du texte of the console (10 to 14 px on a
// 14 px design base, ../.. apps/console/src/lib/shell/text-size.ts): the page zoom
// factors the shell accepts. The preload repeats these literals (it cannot
// import runtime values); change all three together.
export const TEXT_ZOOM_FACTORS: readonly number[] = [10, 11, 12, 13, 14].map((size) => size / 14);

/** The console's default text size (14 px, DEFAULT_TEXT_SIZE), before it says otherwise. */
export const DEFAULT_TEXT_ZOOM = 1;

export function isTextZoom(value: unknown): value is number {
  return typeof value === "number" && TEXT_ZOOM_FACTORS.includes(value);
}
