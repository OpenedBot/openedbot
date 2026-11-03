/**
 * The core routes the session middleware lets through: they authenticate
 * otherwise (signed hook deliveries, a bearer, an invitation token) or are
 * public. The API adds the public plug-in mounts (`proPublicPathMatcher`)
 * and the payment webhook path the plug-in billing declares
 * (`paymentWebhookMountOf`, step 11.5). Kept here, out of `index.ts`, so
 * that a test can pin it.
 */

export function isSessionlessCorePath(path: string): boolean {
  return (
    path.startsWith("/api/invite/member/") ||
    path === "/api/health" ||
    path === "/api/auth/login" ||
    path === "/api/auth/login/code" ||
    path === "/api/auth/login/code/verify" ||
    path === "/api/auth/providers" ||
    path === "/api/auth/google/start" ||
    path === "/api/auth/google/callback" ||
    path === "/api/auth/attempts/claim" ||
    path.startsWith("/api/auth/native/")
    || path.startsWith("/api/hooks/")
    || path === "/api/legal"
    || path.startsWith("/api/legal/")
    || path.startsWith("/api/mcp-oauth/")
    || path.startsWith("/api/mcp/routines/")
    || path.startsWith("/api/mcp/bot-settings/")
    || path.startsWith("/api/support/")
  );
}
