export type AuthUserDto = { id?: string; email: string; displayName: string | null };

export type AuthStartDto = { attemptId: string; authorizeUrl: string };

/**
 * `origin_unsupported`: Google is configured, but the origin where the page
 * is opened cannot receive the session the callback sets: the case of
 * LAN access by IP in development, where the OAuth callback stays bound to
 * `API_PUBLIC_URL` (Google refuses a private IP as a redirect URI).
 */
type AuthProviderDisabledReason = "not_configured" | "disabled" | "origin_unsupported";

export type EmailLoginCodeDto = { sent: true };

export type EmailLoginDto = { csrfToken: string; organizationId: string | null; user: AuthUserDto };

export type PasswordLoginCodeRequiredDto = { status: "code_required" };

export type AuthProvidersDto = {
  emailCode?: { enabled: boolean };
  google: { enabled: true } | { enabled: false; reason: AuthProviderDisabledReason };
  /**
   * Email and password sign-in. `enabled: false` in production
   * (`OPENEDBOT_ENV=production`). Google and e-mail codes remain available.
   * Dev and preprod keep password sign-in.
   */
  password: { enabled: true } | { enabled: false };
  /** Development only: the personal account retained for existing consumers. */
  devSignIn?: { email: string; password: string };
};

export type AuthFailureCode =
  | "AUTH_ATTEMPT_UNKNOWN"
  | "AUTH_RETURN_ORIGIN_UNTRUSTED"
  | "AUTH_STATE_INVALID"
  | "AUTH_DENIED"
  | "AUTH_EXCHANGE_FAILED"
  | "AUTH_TOKEN_INVALID"
  | "AUTH_EMAIL_NOT_VERIFIED"
  /** No longer raised (signup is open); kept so published clients still name it. */
  | "AUTH_EMAIL_NOT_ALLOWED"
  | "AUTH_NOT_A_MEMBER"
  | "AUTH_SIGNUP_FAILED"
  /** Google SSO refused: Google was unlinked from this account from « Mon compte ». */
  | "AUTH_GOOGLE_UNLINKED"
  /** Link refused: the Google address is not the account's. */
  | "GOOGLE_EMAIL_MISMATCH"
  /** Link refused: this Google account is already linked to another user. */
  | "GOOGLE_ALREADY_LINKED";

export type AuthClaimDto =
  | { status: "pending" }
  | { status: "done"; user: AuthUserDto }
  | { status: "failed"; code: AuthFailureCode };

/**
 * Who sees a product feature switched on in production: nobody, assisted
 * sessions only (a read-only session someone opened on the user's behalf),
 * or everyone. Development ignores it (see `ProductFeatureSwitch`).
 */
export type ProductFeatureAudience = "off" | "assisted" | "all";

/**
 * One product feature flag: switched on or off per environment. The API
 * reads `prod` (production and preprod) or `dev` (`OPENEDBOT_ENV=development`).
 */
export type ProductFeatureSwitch = { key: string; dev: boolean; prod: boolean; audience: ProductFeatureAudience };

export type ResolvedProductFeatures = Record<string, boolean>;

export type AuthMeDto = {
  user: AuthUserDto;
  organization?: { id: string; slug: string; name: string; kind?: "personal" };
  role: string;
  /**
   * Set on an assisted session (opened read-only on the user's behalf),
   * `null` otherwise. The field keeps its historical name: shipped clients
   * (the iOS app) read it.
   */
  impersonation?: { readOnly: true } | null;
  mustChangePassword?: boolean;
  features: ResolvedProductFeatures;
  /**
   * The non-core entitlements this session holds (`<plug-in id>.<feature>`,
   * sorted); core features are implicit. The console reads what it may show
   * here, never from the HTTP status of a plug-in route.
   */
  entitlements?: string[];
};
