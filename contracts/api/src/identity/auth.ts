export type AuthUserDto = { id?: string; email: string; displayName: string | null };

export type AuthStartDto = { attemptId: string; authorizeUrl: string };

/**
 * `origin_unsupported` : Google est bien configuré, mais l'origine d'où la page
 * est ouverte ne peut pas recevoir la session que pose le callback : cas de
 * l'accès LAN par IP en développement, où le callback OAuth reste lié à
 * `API_PUBLIC_URL` (Google refuse une IP privée comme URI de redirection).
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
  /**
   * Signup waitlist gate. `required: true` : a new account needs staff
   * approval. Absent on older payloads : the client fails closed (required).
   */
  waitlist?: { required: boolean };
  /** Development only: the personal account retained for existing consumers. */
  devSignIn?: { email: string; password: string };
  /** Development only: seeded users offered as explicit role choices on `/login`. */
  devSignIns?: Array<{ email: string; password: string; role: "owner" | "agency" }>;
};

export type AuthFailureCode =
  | "AUTH_ATTEMPT_UNKNOWN"
  | "AUTH_RETURN_ORIGIN_UNTRUSTED"
  | "AUTH_STATE_INVALID"
  | "AUTH_DENIED"
  | "AUTH_EXCHANGE_FAILED"
  | "AUTH_TOKEN_INVALID"
  | "AUTH_EMAIL_NOT_VERIFIED"
  | "AUTH_EMAIL_NOT_ALLOWED"
  | "AUTH_NOT_A_MEMBER"
  | "AUTH_SIGNUP_FAILED"
  | "MEMBER_QUOTA_REACHED"
  /** SSO Google refusé : Google a été délié de ce compte depuis « Mon compte ». */
  | "AUTH_GOOGLE_UNLINKED"
  /** Liaison refusée : l’adresse Google n’est pas celle du compte. */
  | "GOOGLE_EMAIL_MISMATCH"
  /** Liaison refusée : ce compte Google est déjà lié à un autre utilisateur. */
  | "GOOGLE_ALREADY_LINKED";

export type AuthClaimDto =
  | { status: "pending" }
  | { status: "done"; user: AuthUserDto }
  | { status: "failed"; code: AuthFailureCode };

/** Product features the backoffice switches at runtime (`GET/PATCH /api/pro/staff/product-features`). */
export type ProductFeatureAudience = "off" | "staff" | "alpha" | "beta" | "all";

export type ResolvedProductFeatures = Record<string, boolean>;

export type AuthMeDto = {
  user: AuthUserDto;
  organization?: { id: string; slug: string; name: string; kind?: "personal" | "agency" };
  role: string;
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
